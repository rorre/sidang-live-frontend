import { Source } from "./source";
import { StreamReader, StreamWriter } from "./stream";
import { InitParser } from "./init";
import { Segment } from "./segment";
import { Track } from "./track";
import {
  Message,
  MessageInit,
  MessagePong,
  MessagePref,
  MessageSegment,
  MessageSegmentFinish,
} from "./message";
import { FragmentedMessageHandler } from "./fragment";

///<reference path="./types/webtransport.d.ts"/>

export class Player {
  mediaSource: MediaSource;
  ipaddr: string;
  init: Map<string, InitParser>;
  audio: Track;
  video: Track;

  quic?: Promise<WebTransport>;
  api?: Promise<WritableStream>;
  url: string;
  started?: boolean;
  paused?: boolean;
  totalSizeProcessed: number;
  // References to elements in the DOM
  vidRef: HTMLVideoElement; // The video element itself
  resolutionsRef: HTMLSelectElement;
  categoryRef: HTMLSelectElement; // The category dropdown

  bufferLevel: Map<string, number>;

  throttleCount: number; // number of times we've clicked the button in a row

  interval?: NodeJS.Timeout;
  timeRef?: DOMHighResTimeStamp;

  // set to performance.now() when ping is sent and set to undefined when pong is received.
  pingStartTime: number | undefined;

  selectedResolution: string | undefined;

  lastSegmentTimestamp: number = -1; // the timestamp value of the last received segment
  serverBandwidth: number; // Kbps - comes from server in each segment in etp field
  tcRate: number; // Kbps - comes from server in each segment in tcRate field
  supress_throughput_value: boolean;
  activeBWTestResult: number;
  activeBWTestInterval: number;
  lastActiveBWTestResult: number;
  chunkStats: any[] = [];
  totalChunkCount = 0; // video track chunk count
  totalChunkLostCount = 0; // video track chunk lost count
  currCategory: string;
  logFunc: Function;
  fragment: FragmentedMessageHandler;
  latencyData: any[] = [];
  windowSize: number;
  isAuto: boolean;
  segmentProcessTimeList: number[];
  totalBufferingDuration: number;
  totalBufferingCount: number;

  // Track the latest end time to prevent recounting gaps
  latestBufferedEnd: number;
  bufferTimeRef: number;
  bufferingStartTime: number | null;
  totalPlayerStallDuration: number;
  totalPlayerStallCount: number;

  waitingTimeout: NodeJS.Timeout | null = null;
  constructor(props: any) {
    this.vidRef = props.vid;
    this.resolutionsRef = props.resolutions;
    this.categoryRef = props.categoryRef;
    this.throttleCount = 0;
    this.totalSizeProcessed = 0;
    this.url = props.url;
    this.activeBWTestInterval = props.activeBWTestInterval * 1000 || 0;
    this.windowSize = 25;
    this.segmentProcessTimeList = new Array<number>();
    this.totalBufferingDuration = 0;
    this.totalBufferingCount = 0;
    this.latestBufferedEnd = 0;
    this.bufferTimeRef = -1;
    this.bufferingStartTime = null;
    this.totalPlayerStallDuration = 0;
    this.totalPlayerStallCount = 0;

    this.logFunc = props.logger;
    this.bufferLevel = new Map();

    this.serverBandwidth = 0;
    this.tcRate = 0;
    this.supress_throughput_value = false;
    this.activeBWTestResult = 0;
    this.lastActiveBWTestResult = 0;

    this.mediaSource = new MediaSource();
    this.vidRef.src = URL.createObjectURL(this.mediaSource);
    this.ipaddr = "";
    this.init = new Map();
    this.audio = new Track(new Source(this.mediaSource), "audio");
    this.video = new Track(new Source(this.mediaSource), "video");
    this.isAuto = this.categoryRef.value === "3";
    this.fragment = new FragmentedMessageHandler();
    this.currCategory = this.getCategoryLabel(this.categoryRef.value);
    if (props.autoStart) {
      this.start();
    }
  }

  start = async () => {
    // player can be started for once
    if (this.started) {
      return;
    }
    this.started = true;
    this.paused = false;

    this.interval = setInterval(this.tick.bind(this), 100);
    this.vidRef.addEventListener("waiting", this.tick.bind(this));

    this.vidRef.addEventListener("error", () => {
      const mediaError = this.vidRef.error;
      console.error("in error | mediaError: %o", mediaError);
      if (mediaError) {
        let errorMessage;
        switch (mediaError.code) {
          case mediaError.MEDIA_ERR_ABORTED:
            errorMessage = "The video playback was aborted.";
            break;
          case mediaError.MEDIA_ERR_NETWORK:
            errorMessage = "A network error caused the video download to fail.";
            break;
          case mediaError.MEDIA_ERR_DECODE:
            errorMessage =
              "The video playback was aborted due to a decoding error.";
            break;
          case mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
            errorMessage = "The video format is not supported.";
            break;
          default:
            errorMessage = "An unknown error occurred.";
            break;
        }
        console.error(
          `Video Error: ${errorMessage} (Code: ${mediaError.code})`
        );
      }
    });

    this.vidRef.addEventListener("waiting", () => {
      if (this.bufferingStartTime === null) {
        this.bufferingStartTime = performance.now();
        this.totalPlayerStallCount++;
        console.log("[BUFFERING] Player is waiting...");

        this.waitingTimeout = setTimeout(() => {
          if (this.bufferingStartTime !== null) {
            console.log(
              "[BUFFERING] Player is still waiting after 5 seconds. Calling goLive..."
            );
            this.goLive();
          }
        }, 5000);
      }
    });

    this.vidRef.addEventListener("stalled", () => {
      if (this.bufferingStartTime === null) {
        this.bufferingStartTime = performance.now();
        this.totalPlayerStallCount++;
        console.log("[BUFFERING] Player is stalled...");

        this.waitingTimeout = setTimeout(() => {
          if (this.bufferingStartTime !== null) {
            console.log(
              "[BUFFERING] Player is still waiting after 5 seconds. Calling goLive..."
            );
            this.goLive();
          }
        }, 5000);
      }
    });

    this.vidRef.addEventListener("playing", () => {
      if (this.bufferingStartTime !== null) {
        const bufferingDuration = performance.now() - this.bufferingStartTime;
        this.totalPlayerStallDuration += bufferingDuration / 1000;
        this.bufferingStartTime = null;
        console.log(
          `[BUFFERING] Buffering ended (playing). Duration: ${bufferingDuration.toFixed(
            2
          )} ms`
        );

        if (this.waitingTimeout) {
          clearTimeout(this.waitingTimeout);
        }
      }
    });

    this.vidRef.addEventListener("canplay", () => {
      if (this.bufferingStartTime !== null) {
        const bufferingDuration = performance.now() - this.bufferingStartTime;
        this.totalPlayerStallDuration += bufferingDuration / 1000;
        this.bufferingStartTime = null;
        console.log(
          `[BUFFERING] Buffering ended (can play). Duration: ${bufferingDuration.toFixed(
            2
          )} ms`
        );

        if (this.waitingTimeout) {
          clearTimeout(this.waitingTimeout);
        }
      }
    });

    this.resolutionsRef.addEventListener("change", this.resolutionOnChange);

    // this.activeBWTestRef.addEventListener('click', this.startActiveBWTest);
    //ADD CATEGORYREF CHANGE EVENT
    this.categoryRef.addEventListener("change", this.changeCategory);
    console.log("in start | url: %s", this.url);
    const quic = new WebTransport(this.url);
    quic.closed.then((info) => {
      console.log("CONNECTION CLOSED:", info);
    });
    this.quic = quic.ready.then(() => {
      return quic;
    });

    // Create a unidirectional stream for all of our messages
    this.api = this.quic.then((q) => {
      return q.createUnidirectionalStream();
    });
    this.timeRef = performance.now();
    // async functions
    this.receiveStreams();
    this.receiveDatagrams();

    this.vidRef.play();

    // Limit to 4Mb/s
    // this.sendThrottle()
  };

  stop = async () => {
    // reset tc netem limiting
    try {
      await this.sendMessage({
        debug: {
          tc_reset: true,
        },
      });
    } finally {
      location.reload();
    }
  };

  categoryChange = () => {
    const currentCategory = this.categoryRef.value;
    console.log("in categoryChange | category: %s", currentCategory);

    const isAutoSwitch = currentCategory === "3";
    const sendMessage = currentCategory !== "";
    let numCategory = isAutoSwitch ? 0 : parseInt(currentCategory); // Defaults to 0 for auto-switching

    if (sendMessage) {
      this.currCategory = this.getCategoryLabel(currentCategory);
      this.isAuto = isAutoSwitch;

      const message = isAutoSwitch
        ? { "x-auto": { auto: true } }
        : {
            "x-category": { category: numCategory },
            "x-auto": { auto: false },
          };

      this.sendMessage(message);
    }
  };

  getCategoryLabel = (category: string) => {
    switch (category) {
      case "0":
        return "Stream";
      case "1":
        return "Datagram";
      case "2":
        return "Hybrid";
      case "3":
        return "Auto";
      default:
        return "Unknown";
    }
  };

  // Used only for auto in handleSegment
  changeQuicType = (categoryNum: number) => {
    const categoryMap = new Map<number, string>([
      [0, "Auto (Stream)"],
      [1, "Auto (Datagram)"],
      [2, "Auto (Hybrid)"],
    ]);

    const prevCategory = this.currCategory;
    this.currCategory = categoryMap.get(categoryNum) || "Unknown";

    if (prevCategory != this.currCategory)
      this.sendMessage({
        "x-category": { category: categoryNum },
      });
  };

  pauseOrResume = (pause?: boolean) => {
    console.log("in pauseOrResume | paused: %s pause: %s", this.paused, pause);
    let sendMessage = false;

    if (!this.paused && (pause === true || pause === undefined)) {
      this.paused = true;
      sendMessage = true;
    } else if (this.paused && !pause) {
      this.paused = false;
      sendMessage = true;
    }

    if (sendMessage) {
      // send a debug message
      this.sendMessage({
        debug: {
          continue_streaming: !this.paused,
        },
      });
    }
  };

  resolutionOnChange = () => {
    const selectedResolution =
      this.resolutionsRef.options[this.resolutionsRef.selectedIndex];
    console.log(
      "in resolutionOnChange | resolution: %s",
      selectedResolution.value
    );

    if (selectedResolution.value.length > 0) {
      this.selectedResolution = selectedResolution.value;
      const resolutionPreference: MessagePref = {
        name: "resolution",
        value: this.selectedResolution,
      };
      this.sendPreference(resolutionPreference);
    }
  };

  continueStreamingClicked = () => {
    this.pauseOrResume();
  };

  changeCategory = () => {
    this.categoryChange();
  };

  async close() {
    if (!this.quic) {
      return;
    }
    clearInterval(this.interval);
    (await this.quic).close();
  }

  sendPreference = async (pref: MessagePref) => {
    console.info("sending preference", pref);
    await this.sendMessage({ "x-pref": pref });
  };
  //send status to server
  async sendMessage(msg: any) {
    if (!this.api) {
      return;
    }

    const payload = JSON.stringify(msg);
    const size = payload.length + 8;

    const stream = await this.api;
    const writer = new StreamWriter(stream);
    await writer.uint32(size);
    await writer.string("warp");
    await writer.string(payload);
    writer.release();
  }

  ping() {
    // a ping already made
    if (this.pingStartTime) {
      return;
    }
    this.pingStartTime = performance.now();
    this.sendPing();
  }

  sendPing() {
    this.sendMessage({
      "x-ping": {},
    });
  }

  tick() {
    // Try skipping ahead if there's no data in the current buffer.
    this.trySeek();

    // Try skipping video if it would fix any desync.
    // NOTE: Disabled to simulate actual live streaming conditions
    // this.trySkip()
  }

  goLive() {
    const ranges = this.vidRef.buffered;
    if (!ranges.length) {
      return;
    }

    this.vidRef.currentTime = ranges.end(ranges.length - 1);
    this.vidRef.play();
  }

  isInNoDataRange(currentTime: number) {
    const ranges = this.vidRef.buffered;
    for (let i = 0; i < ranges.length; i += 1) {
      const start = ranges.start(i);
      const end = ranges.end(i);
      if (currentTime >= start && currentTime <= end) {
        return false;
      }
    }
    return true;
  }

  // Try seeking ahead to the next buffered range if there's a gap
  trySeek() {
    if (
      this.vidRef.readyState > 2 &&
      !this.isInNoDataRange(this.vidRef.currentTime)
    ) {
      // HAVE_CURRENT_DATA
      // No need to seek
      return;
    }

    const ranges = this.vidRef.buffered;
    if (!ranges.length) {
      // Video has not started yet
      return;
    }

    for (let i = 0; i < ranges.length; i += 1) {
      const pos = ranges.start(i);

      if (this.vidRef.currentTime >= pos) {
        // This would involve seeking backwards
        continue;
      }

      console.warn("seeking forward", pos - this.vidRef.currentTime);

      this.vidRef.currentTime = pos;
      return;
    }
  }

  // Try dropping video frames if there is future data available.
  trySkip() {
    let playhead: number | undefined;

    if (this.vidRef.readyState > 2) {
      // If we're not buffering, only skip video if it's before the current playhead
      playhead = this.vidRef.currentTime;
    }

    this.video.advance(playhead);
  }

  async receiveDatagrams() {
    if (!this.quic) {
      return;
    }

    let counter = 0;
    const q = await this.quic;

    const datagrams = q.datagrams.readable.getReader();

    datagrams.closed.then((info) => {
      console.log("DATAGRAMS CLOSED:", info);
    });

    while (true) {
      ++counter;
      const result = await datagrams.read();
      if (result) {
        // console.log("datagram masuk")
      }

      if (result.done) {
        console.log("datagram break");
        break;
      }

      this.fragment.handleDatagram(result.value, this);
    }
  }

  async receiveStreams() {
    if (!this.quic) {
      return;
    }

    let counter = 0;
    const q = await this.quic;

    const streams = q.incomingUnidirectionalStreams.getReader();

    streams.closed.then((info) => {
      console.log("STREAMS CLOSED:", info);
    });

    while (true) {
      ++counter;
      const result = await streams.read();
      if (result) {
        // console.log("stream masuk")
      }
      if (result.done) {
        console.log("stream break");
        break;
      }
      const stream = result.value;
      let r = new StreamReader(stream.getReader());

      this.fragment.handleStream(r, this); // don't await
    }
  }

  async handleStream(r: StreamReader) {
    while (true) {
      const handleSegmentStartTime = performance.now();

      if (await r.done()) {
        break;
      }

      const size = await r.uint32();
      // console.log("Size: " + size)
      const typ = new TextDecoder("utf-8").decode(await r.bytes(4));
      // console.log("Type: " + typ)
      if (typ !== "warp") throw "expected warp atom";
      if (size < 8) throw "atom too small";

      const payload = new TextDecoder("utf-8").decode(await r.bytes(size - 8));
      const msg = JSON.parse(payload) as Message;
      // console.log("msg", msg)

      if (msg.init) {
        // console.log("Msg Init: ", msg.init)
        return this.handleInit(r, msg.init);
      } else if (msg.segment) {
        // console.log("Msg Segment: ", msg.segment)
        return this.handleSegment(r, msg.segment, handleSegmentStartTime);
      } else if (msg.pong) {
        return this.handlePong(r, msg.pong);
      } else if (msg.finish) {
        return this.handleSegmentFinish(r, msg.finish);
      }
    }
  }

  async handleSegmentFinish(stream: StreamReader, msg: MessageSegmentFinish) {
    this.fragment.closeSegment(msg.segment_id.toString());
  }

  // TODO: time-sync should be made for this to give correct result
  async handlePong(stream: StreamReader, msg: MessagePong) {
    if (!this.pingStartTime) {
      console.warn("in handlePong | pingStartTime is undefined.");
      return;
    }
    const latency = performance.now() - this.pingStartTime;
    console.log("Latency is: %d ms", latency);
    this.pingStartTime = undefined;
  }

  async handleInit(stream: StreamReader, msg: MessageInit) {
    let init = this.init.get(msg.id);
    if (!init) {
      init = new InitParser();
      this.init.set(msg.id, init);
    }

    while (1) {
      const data = await stream.read();
      //request arrived
      if (!data) break;
      // console.log("init", data)
      init.push(data);
    }
  }

  async handleSegment(
    stream: StreamReader,
    msg: MessageSegment,
    segmentStartOffset: number
  ) {
    let initParser = this.init.get(msg.init);
    if (!initParser) {
      initParser = new InitParser();
      this.init.set(msg.init, initParser);
    }

    // Wait for the init segment to be fully received and parsed
    const init = await initParser.ready;
    //request arrived
    let track: Track;
    if (init.info.videoTracks.length) {
      track = this.video;
    } else {
      track = this.audio;
    }

    const hasInitialized = track.source.initialize(init);
    if (!hasInitialized) {
      for (let i = 0; i < init.raw.length; i += 1) {
        track.source.append(init.raw[i], false);
      }
    }
    await this.video.source.initialized;
    await this.audio.source.initialized;
    track.source.flush();

    // since streams are multiplexed
    // a stale segment may come later which changes the latest
    // etp and tc_rate values inadvertently.
    if (msg.timestamp >= this.lastSegmentTimestamp) {
      this.serverBandwidth = msg.etp * 1024; // in bits, comes as Kbps
      this.tcRate = msg.tc_rate * 1024; // in bits, comes as Kbps
    }
    this.lastSegmentTimestamp = msg.timestamp;

    // TODO: UNCOMMENT LOG
    // console.log('msg: %o tcRate: %d serverBandwidth: %d', msg, this.tcRate, this.serverBandwidth)

    //single check to update IP Address for metric purposes
    if (this.ipaddr === "") {
      this.ipaddr = msg.client_addr;
    }

    const segment = new Segment(track.source, init, msg.timestamp);
    // The track is responsible for flushing the segments in order

    /* TODO I'm not actually sure why this code doesn't work; something trips up the MP4 parser
			while (1) {
				const data = await stream.read()
				if (!data) break

				segment.push(data)
				track.flush() // Flushes if the active segment has samples
			}
		*/
    try {
      while (true) {
        if (await stream.done()) {
          break;
        }

        const raw = await stream.peek(4);
        const size = new DataView(
          raw.buffer,
          raw.byteOffset,
          raw.byteLength
        ).getUint32(0);
        const atom = await stream.bytes(size);
        segment.push(atom);
        segment.flush();
        track.add(segment);
        // track.flush() // Flushes if the active segment has new samples
      }
    } catch (e) {
      console.error("Error happened!", e);
    }

    segment.finish();
  }
}
