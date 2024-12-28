import { Player } from "./player";
import { StreamReader } from "./stream"
import { Mutex } from 'async-mutex'

type MessageFragment = {
	segmentID: string;
	chunkID: string;
	chunkNumber: number;
	fragmentNumber: number;
	fragmentTotal: number;
	data: Uint8Array;
};

export class FragmentedMessageHandler {
	//Add Parameter for StatsRef to update stats and throughput map of player.
	private fragmentBuffers: Map<string, (Uint8Array | null)[]>;
	private chunkBuffers: Map<string, [chunkNumber: number, data: Uint8Array][]>;
	private chunkCount: Map<string, number>;
	private chunkTotal: Map<string, number>;
	private segmentStreams: Map<string, ReadableStreamDefaultController<Uint8Array>>;
	private segmentInitialized: Map<string, boolean>;
	private mutex: Mutex;

	constructor() {
		this.fragmentBuffers = new Map();
		this.chunkBuffers = new Map();
		this.chunkCount = new Map();
		this.chunkTotal = new Map();
		this.segmentStreams = new Map();
		this.segmentInitialized = new Map();
		this.mutex = new Mutex()
	}

	// warp, styp, moof & mdat (I-frame)
	async handleStream(r: StreamReader, player: Player) {
		// console.log("Masuk handleStream Fragment")
		const isHybrid = Boolean((await r.bytes(1)).at(0))
		if (!isHybrid) {
			// console.log("stream masuk 2")
			player.handleStream(r)
			return
		}
		
		const buf = await r.bytes(2);
		const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		const segmentID = dv.getUint16(0).toString();
		if (!this.segmentStreams.has(segmentID)) {
			// console.log("STREAM CREATE ", segmentID)
			this.initializeStream(segmentID, player);
		}

		let count = 0
		let moof: Uint8Array = new Uint8Array();
		const controller = this.segmentStreams.get(segmentID)

		// setTimeout(() => {
		// 	setInterval(() => {
		// 		const chunkBuffers = this.chunkBuffers.get(segmentID)
		// 		while (chunkBuffers !== undefined && controller !== undefined && chunkBuffers.size() !== 0) {
		// 			this.enqueueChunk(segmentID, chunkBuffers.dequeue(), controller)
		// 		}
		// 	}, 500);
		// }, 2100);

		while (controller !== undefined) {
			if (await r.done()) {
				break;
			}

			const raw = await r.peek(4)
			const size = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0)
			if (count < 2) { // init & styp
				// controller.enqueue(await r.bytes(size))
				this.enqueueChunk(segmentID, await r.bytes(size), controller, true)
				this.segmentInitialized.set(segmentID, true)
			} else if (count % 2 === 0) {
				moof = await r.bytes(size)
			} else if (count % 2 !== 0) {
				const mdat = await r.bytes(size)
				const chunk = new Uint8Array(moof.length + mdat.length)
				chunk.set(moof)
				chunk.set(mdat, moof.length)
				// controller.enqueue(chunk)
				this.enqueueChunk(segmentID, chunk, controller)
			}
			count++
		}

		// while (controller !== undefined) {
		// 	if (await r.done()) {
		// 		this.isDelayed.set(segmentID, false)
		// 		const chunkBuffers = this.chunkBuffers.get(segmentID)
		// 		while (chunkBuffers !== undefined && controller !== undefined && chunkBuffers.size() !== 0) {
		// 			this.enqueueChunk(segmentID, chunkBuffers.dequeue(), controller)
		// 		}
		// 		console.log('end of stream')
		// 		break;
		// 	}

		// 	controller.enqueue(await r.read())
		// }
		// let count = this.chunkCount.get(segmentID)
		// if (count === undefined) {
		// 	return
		// }
		// this.chunkCount.set(segmentID, count+3);
	}

	async handleDatagram(datagram: Uint8Array, player: Player) {
		const fragment = this.parseDatagram(datagram);
			
		if (!this.segmentStreams.has(fragment.segmentID)) {
			// console.log("DATAGRAM CREATE ", fragment.segmentID)
			this.initializeStream(fragment.segmentID, player);
		}

		this.mutex.runExclusive(() => this.storeFragment(fragment))
	}

	async closeSegment(segmentId: string) {
		this.cleanup(segmentId)
	}

	private initializeStream(segmentID: string, player: Player) {
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				this.chunkCount.set(segmentID, 0);
				this.segmentStreams.set(segmentID, controller);
			},
			cancel: () => {
				this.cleanup(segmentID);
				// console.log("CANCEL", segmentID)
			}
		});
		let r = new StreamReader(stream.getReader())
		player.handleStream(r);
	}

	private storeFragment(fragment: MessageFragment) {
		if (!this.chunkBuffers.has(fragment.segmentID)) {
			this.chunkBuffers.set(fragment.segmentID, [])
		}

		if (!this.fragmentBuffers.has(fragment.chunkID)) {
			this.fragmentBuffers.set(fragment.chunkID, new Array(fragment.fragmentTotal).fill(null))
		}

		const fragmentBuffer = this.fragmentBuffers.get(fragment.chunkID);
		if (fragmentBuffer) {
			fragmentBuffer[fragment.fragmentNumber] = fragment.data;
			if (fragmentBuffer.every(element => element !== null)) {
				this.writeFragment(fragment.chunkID, fragment.segmentID, fragment.chunkNumber)
				this.flushChunks(fragment.segmentID)
			}
		}
	}

	private writeFragment(chunkId: string, segmentId: string, chunkNumber: number) {
		const fragmentBuffer = this.fragmentBuffers.get(chunkId)
		if (!fragmentBuffer) return

		for (let i = 0; i < fragmentBuffer.length; i++) {
			if (fragmentBuffer[i] === null) {
				console.error(`Missing fragment ${i} in chunk ${chunkId}`)
				return
			} else {
				// console.log(`Decoded fragment ${i}: ${new TextDecoder().decode(fragmentBuffer[i]!)}`)
			}
		}
		
		const cleanedBuf = fragmentBuffer.filter(x => x != null)
		const totalLength = cleanedBuf.reduce((acc, val) => acc + val.length, 0);
		const completeData = new Uint8Array(totalLength);

		// Copy each Uint8Array into completeData
		let offset = 0;
		cleanedBuf.forEach((chunk) => {
			completeData.set(chunk, offset);
			offset += chunk.length;
		});

		if (!this.chunkBuffers.has(segmentId)) {
			this.chunkBuffers.set(segmentId, [])
		}
		const chunkBuffers = this.chunkBuffers.get(segmentId)
		if (!chunkBuffers) return;

		this.enqueueChunk(segmentId, completeData, this.segmentStreams.get(segmentId)!);
		this.fragmentBuffers.delete(chunkId);
	}

	private writeUnfinishedFragment(chunkId: string, segmentId: string, chunkNumber: number) {
		const fragmentBuffer = this.fragmentBuffers.get(chunkId)
		if (!fragmentBuffer) return

		const idx = fragmentBuffer.indexOf(null)
		const cleanedBuf = fragmentBuffer.slice(0, idx) as Uint8Array[]
		const totalLength = cleanedBuf.reduce((acc, val) => acc + val.length, 0);
		const completeData = new Uint8Array(totalLength);

		// Copy each Uint8Array into completeData
		let offset = 0;
		cleanedBuf.forEach((chunk) => {
			completeData.set(chunk, offset);
			offset += chunk.length;
		});

		const mdatIndex = new TextDecoder().decode(completeData).indexOf('mdat');
		if (mdatIndex == -1 || mdatIndex <= 4) {
			console.error(`'mdat' atom not found or in an unexpected location in fragment 0 for chunkID: ${chunkId}`);
			return false; // Ensure 'mdat' is present and correctly positioned
		}

		const dv = new DataView(completeData.buffer)
		let mdatSize = -1;
		const sizeStartIndex = mdatIndex - 4;
		if (mdatIndex > 4) {
			mdatSize = dv.getUint32(sizeStartIndex);
			if (mdatSize === -1) {
				console.error(`Invalid or missing 'mdat' atom size in fragment 0 for chunkID: ${chunkId}`);
				return false; // Return false if the size is not properly set
			}
			mdatSize -= completeData.length - sizeStartIndex
		}

		console.log(`[UNFRAG] Found 'mdat' atom with size ${mdatSize} in fragment 0 for chunkID: ${chunkId}`);
		console.log("[UNFRAG] Start parsing NAL Units")
		let currentNalIdx = mdatIndex + 4
		while (currentNalIdx < completeData.length) {
			const length = dv.getUint32(currentNalIdx)
			if (currentNalIdx + length + 4 >= completeData.length) {
				break
			}

			currentNalIdx = currentNalIdx + length + 4
		}
		console.log("[UNFRAG] Final idx is " + currentNalIdx)
		if (currentNalIdx == mdatIndex + 4) return;
		console.log("[UNFRAG] Final size is " + (currentNalIdx - mdatIndex))

		dv.setUint32(sizeStartIndex, currentNalIdx - mdatIndex);
		const actualCompleteData = dv.buffer.slice(0, currentNalIdx)
		if (!this.chunkBuffers.has(segmentId)) {
			this.chunkBuffers.set(segmentId, [])
		}
		
		const chunkBuffers = this.chunkBuffers.get(segmentId)
		if (!chunkBuffers) return;

		this.enqueueChunk(segmentId, new Uint8Array(actualCompleteData), this.segmentStreams.get(segmentId)!);
		this.fragmentBuffers.delete(chunkId);
	}

	private flushChunks(segmentId: string) {
		const unfinishedFragments = Array.from(this.fragmentBuffers.keys()).filter((x) => x.startsWith(segmentId))
		let unfinishedChunkCount = 0
		unfinishedFragments.forEach((chunkId) => {
			unfinishedChunkCount++
			const arr = this.fragmentBuffers.get(chunkId)!
			const totalNulls = arr.filter((x) => x == null).length
			console.warn("Found unfinished chunk with ID:", chunkId, `(${totalNulls}/${arr.length} fragment missing) at indexes ${arr.map((x, i) => x == null ? i : -1).filter((x) => x != -1)}`)

			const chunkNumber = Number(chunkId.split("-")[1])
			this.writeUnfinishedFragment(chunkId, segmentId, chunkNumber)
		})

		this.chunkBuffers.delete(segmentId)
	}
	

	private enqueueChunk(segmentID: string, chunk: Uint8Array | undefined, controller: ReadableStreamDefaultController<Uint8Array>, initializer: boolean = false) {
		const t = performance.now()
		while (!this.segmentInitialized.get(segmentID) && !initializer) {
			if (performance.now() - t > 1000) {
				return
			}
		}

		if (chunk === undefined) {
			return
		}
		
		const boxType = fromCharCodeUint8([...chunk.slice(4, 8)]);
		if (boxType === 'finw') {
			const dv = new DataView(chunk.slice(8).buffer, chunk.slice(8).byteOffset, chunk.slice(8).byteLength);
			this.handleFin(dv.getUint16(0).toString(), dv.getUint8(2));
			return
		}

		let count = this.chunkCount.get(segmentID)
		if (count === undefined) {
			return
		}

		count++
		this.chunkCount.set(segmentID, count);
		try {
			controller.enqueue(chunk);
		} catch {
			throw "controller is closed"
		}
		
		if (count === this.chunkTotal.get(segmentID)) {
			this.cleanup(segmentID)
		}
	}

	private handleFin(segmentID: string, chunkTotal: number) {
		const count = this.chunkCount.get(segmentID)
		if (chunkTotal === count) {
			this.cleanup(segmentID)
		} else {
			this.chunkTotal.set(segmentID, chunkTotal)
		}
	}

	private cleanup(segmentID: string) {
		this.flushChunks(segmentID);
		setTimeout(() => {
			this.segmentStreams.get(segmentID)?.close()
			this.segmentStreams.delete(segmentID);
			this.chunkBuffers.delete(segmentID);
		}, 1000)
		// console.log("DELETE ", segmentID)
	}

	private parseDatagram(datagram: Uint8Array): MessageFragment {
		const buf = datagram.slice(0, 7);
		const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		const segmentID = dv.getUint16(0).toString();
		const chunkNumber = dv.getUint8(2);
		const chunkID = segmentID.toString() + "-" + chunkNumber.toString()
		const fragmentNumber = dv.getUint16(3);
		const fragmentTotal = dv.getUint16(5);
		const data = new Uint8Array(datagram.buffer.slice(7));

		return { segmentID, chunkID, chunkNumber, fragmentNumber, fragmentTotal, data };
	}
}

function fromCharCodeUint8(uint8arr: any[]) {
	var arr = [];
	for (var i = 0; i < uint8arr.length; i++) {
		arr[i] = uint8arr[i];
	}
	return String.fromCharCode.apply(null, arr);
}
