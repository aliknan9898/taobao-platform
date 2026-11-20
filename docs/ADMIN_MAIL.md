# KINAN Admin email

The KINAN Email section uses the existing Gmail account that receives forwarded
messages for hello, info, sellers and support at kinan.shop. It filters each
address by recipient headers. The message view displays plain text or a Gmail
snippet. Attachments and rich HTML remain available in Gmail.

1. Verify each KINAN address in the receiving account's Gmail **Send mail as**
   settings.
2. Enable the Gmail API in Google Cloud. Authorize the receiving account using
   an OAuth client with offline access and scopes
   `https://www.googleapis.com/auth/gmail.readonly` and
   `https://www.googleapis.com/auth/gmail.send`.
3. Set `ADMIN_MAIL_GOOGLE_CLIENT_ID`, `ADMIN_MAIL_GOOGLE_CLIENT_SECRET` and
   `ADMIN_MAIL_GMAIL_REFRESH_TOKEN` in the KINAN server's secret environment.
   Use the client that issued the refresh token.
4. In Admin → KINAN Email, open a mailbox with a known forwarded message and
   send a test from a verified address to an address you control. Confirm the
   recipient sees the selected KINAN address.
