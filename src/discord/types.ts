export type AlertChannel = {
  send(content: string): Promise<{ id: string }>
}
