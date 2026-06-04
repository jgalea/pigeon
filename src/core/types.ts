export type SessionStatus = 'STARTING' | 'SCAN_QR_CODE' | 'WORKING' | 'STOPPED' | 'FAILED'

export interface NormalizedMessage {
  session: string
  chatId: string
  msgId: string
  fromMe: boolean
  timestamp: number
  type: string
  body?: string
  caption?: string
  mediaPath?: string
  raw: unknown
}

export type OutgoingType = 'text' | 'image' | 'file' | 'voice' | 'video' | 'location'

export interface OutgoingMedia {
  data?: string
  url?: string
  mimetype?: string
  filename?: string
}

export interface OutgoingMessage {
  chatId: string
  type: OutgoingType
  text?: string
  caption?: string
  media?: OutgoingMedia
  location?: { latitude: number; longitude: number }
}

export interface WebhookEvent {
  session: string
  event: string
  payload: unknown
  timestamp: number
}
