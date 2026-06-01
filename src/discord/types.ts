export type AlertChannel = {
  send(content: string): Promise<{ id: string }>
  edit(messageId: string, content: string): Promise<void>
}
