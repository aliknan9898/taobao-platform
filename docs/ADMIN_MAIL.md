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

## Employee access

Use a dedicated Google mailbox with a primary `@kinan.shop` address that is
separate from the project owner's sign-in and personal Gmail. Route only project
mail to it. Set `ADMIN_MAIL_STAFF_ACCOUNT` to its exact primary address and
authorize that dedicated account in the steps above. The server checks the
authenticated Gmail profile before an employee can read or send any mail.

In Admin → Staff & activity, assign each operator only the addresses needed
for their job. The audit trail records mailbox reads and send attempts under the
employee account, including the business address and sent message ID when
available. It does not store the subject or body.

### How employee access is enforced

- Employee mail stays off unless `ADMIN_MAIL_STAFF_ACCOUNT` is set to an `@kinan.shop` address that is not the
  owner's, and the connected Gmail account's own profile reports exactly that address. A confirmed match is cached for
  five minutes; a mismatch is checked again on every request.
- Each request is checked on the server against the aliases assigned to that employee: the inbox list, opening a
  message by ID, replying in a thread, and the sender address. A message is shown for an alias only if its `To`, `Cc`,
  `Delivered-To` or `X-Original-To` header names that alias; a reply is allowed only to such a message.
- Admin sends each message with a `client_send_id`. The same ID from the same person within 24 hours returns the first
  result, so a double click or a retry after a dropped connection does not send the email twice. A send that failed at
  Gmail can be retried with the same ID.

### Known limitations

- Alias isolation uses the message headers of one shared mailbox. A sender can write any address in `To`, so a message
  delivered to one alias but addressed to another appears under the alias it names. For strict separation, give each
  alias its own mailbox (or verified routing that adds a trusted header) before assigning employees to different
  aliases.
- "Online" is approximate: a 25-second heartbeat from an open Admin tab, kept in the memory of the single web instance.
  It resets on restart and would need shared storage if Render runs more than one instance.
