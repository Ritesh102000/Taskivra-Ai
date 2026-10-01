export const APP_URL = 'app://desktop/index.html';
export interface SenderIdentity {
  senderId: number; trustedWebContentsId: number;
  isMainFrame: boolean; url: string;
}
export function isTrustedSender(sender: SenderIdentity): boolean {
  return Number.isSafeInteger(sender.senderId) && sender.senderId > 0
    && Number.isSafeInteger(sender.trustedWebContentsId) && sender.trustedWebContentsId > 0
    && sender.senderId === sender.trustedWebContentsId && sender.isMainFrame === true && sender.url === APP_URL;
}
export const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
