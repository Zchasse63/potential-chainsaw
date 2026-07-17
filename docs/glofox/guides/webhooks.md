Glofox supports webhooks for real-time updates. Configure each webhook to send events to one or more target URLs.

See the [webhook documentation](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Webhooks) for a list of available webhooks.

## Timeouts and retries

Glofox sends each webhook to the configured URL as an HTTP `POST` request.

**Timeout:** The receiving endpoint must complete processing and return a response within **5 seconds** , measured from connection establishment through delivery of the response. If the endpoint does not return a successful response within that interval, Glofox treats the delivery as failed.

**Retries:** When a delivery fails, Glofox retries up to **three times** in total for the same event. Delivery is **at-least-once** ; Glofox may POST the same logical event multiple times. Make your implementation **idempotent** : key processing on a **stable event identifier** or **message identifier** and no-op (or return success) when you already processed that identifier successfully.

## Member webhook

The **Member** webhook notifies your integration when a member is created or updated. There are two event types: `MEMBER_CREATED` and `MEMBER_UPDATED`.

__

Member deletions

Glofox does **not** emit a `MEMBER_DELETED` event. When a member is deleted, the system performs a **soft delete** by setting `active` to `false` on the member record. That change is delivered as a `MEMBER_UPDATED` event. Integrations should treat `MEMBER_UPDATED` events where `active` is `false` as a member becoming inactive, not as a permanent removal.

Soft-deleted members are **not** permanently removed. Staff can restore them in Glofox, and the same member record is reactivated when the member re-registers (`active` is set back to `true`, delivered as a further `MEMBER_UPDATED` event). Do not permanently purge member data in your integration based solely on `active: false`.

## Access webhook

The **Access** webhook notifies your integration when a member creates or updates a barcode. Use it to keep barcode identifiers in sync with your systems, such as access hardware or third-party apps that rely on the current barcode value. This webhook covers barcode updates, not access-grant events. It does not fire when the system grants or denies access; it fires when a member creates or updates a barcode.

__

Summary

**Access webhook:** barcode create and update events. **Not included:** access granted or denied events.

To ensure data consistency, supplement webhooks with a daily sync. For example, listen for `POST` events on the `member` webhook and perform a daily sync using [`/2.0/members`](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Users/paths/~12.0~1members/get) with appropriate filters.

__

**Webhook signature:** Each webhook includes a `signature` header for source validation. Glofox provides the secret key for webhooks with your API credentials. The signature is a hexadecimal string that uses hash-based message authentication code with the 256-bit Secure Hash Algorithm, computed as `Signature = Hex( HMAC-SHA256( YourSecretKey, StringToSign ))`
