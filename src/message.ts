export interface Message {
	init?: MessageInit
	segment?: MessageSegment
	ping?: MessagePing
	pong?: MessagePong
	finish?: MessageSegmentFinish
}

export interface MessageInit {
	id: string
}

export interface MessageSegment {
	init: string // id of the init segment
	timestamp: number // presentation timestamp in milliseconds of the first sample
	etp: number // estimated throughput in Kbps / CTA 5006
	tc_rate: number // applied tc netem rate in Mbps
	at: number // availability time / CTA 5006
	client_addr: string // local address, the sessions current IP address
}

export interface MessagePing {

}


export interface MessagePong {

}

// user preference
export interface MessagePref {
	name: string;
	value: string;
}

export interface Debug {
	max_bitrate: number
}

export interface MessageSegmentFinish {
	segment_id: number
}