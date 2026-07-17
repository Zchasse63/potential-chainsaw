This guide covers how to register a device for push notifications and how to consume the resulting webhook event.

## Register a device

Use the **Register device** endpoint to register a mobile device that should receive push notifications.

**Endpoint:** `POST /v3.0/push-notifications/devices`

**Method:** `POST`

**Content-Type:** `application/json`

**Headers:**
    
    
    {
      "x-glofox-branch-id": "{branch_id}",
      "x-api-key": "{api_key}",
      "x-glofox-api-token": "{api_token}",
      "x-glofox-impersonated-member-id": "{member_id}"
    }

**Request Body:**
    
    
    {
      "bundle": "xtreme_custom_app",
      "device_id": "device-token-or-id",
      "os": "ios",
      "version": {
        "major": 1,
        "minor": 0,
        "revision": 3
      }
    }

Field | Type | Description  
---|---|---  
`bundle` | string | The app bundle/package identifier. Provided by ABC.  
`device_id` | string | The unique device identifier or push token used to target the device. Keep this identifier up to date on the client.  
`os` | string | The device operating system, such as `ios` or `android`.  
`version.major` | integer | Major version of the app installed on the device.  
`version.minor` | integer | Minor version of the app installed on the device.  
`version.revision` | integer | Revision or patch version of the app installed on the device.  
  
A successful request returns **201 Created** with the registered device details:
    
    
    {
      "bundle": "com.example.app",
      "device_id": "device-token-or-id",
      "location_id": "location-id",
      "os": "ios",
      "user_id": "user-id",
      "version": {
        "major": 1,
        "minor": 0,
        "revision": 3
      }
    }

> **Note:** Glofox registers only one device at a time per user. Registering a new device overrides the previous one. Re-register whenever the push token, app version, or operating system changes.

## Receive push notification webhook events

When Glofox creates a push notification, it dispatches a webhook event with event type `PUSH_NOTIFICATION_CREATED`.

**Webhook event example:**
    
    
    {
      "Type": "PUSH_NOTIFICATION_CREATED",
      "Metadata": {
        "trace_id": "string",
        "location_id": "location-id",
        "version": "string"
      },
      "Timestamp": "2026-03-18T15:47:21.411Z",
      "Payload": {
        "to": [
          {
            "user_id": "user-id",
            "device_id": "device-id"
          }
        ],
        "notification": {
          "title": "Notification title",
          "body": "Notification message"
        }
      }
    }

Field | Description  
---|---  
`Type` | The event type. For push notifications, this is `PUSH_NOTIFICATION_CREATED`.  
`Metadata.trace_id` | Identifier used for tracing and troubleshooting the event.  
`Metadata.location_id` | Location associated with the notification.  
`Metadata.version` | Event schema or integration version.  
`Timestamp` | When Glofox generated the event, in ISO 8601 UTC format.  
`Payload.to` | List of target recipients and devices for the notification.  
`Payload.to[].user_id` | User targeted by the notification.  
`Payload.to[].device_id` | Device targeted by the notification.  
`Payload.notification.title` | Title shown in the push notification.  
`Payload.notification.body` | Message body shown in the push notification.  
  
  * Use `Payload.to` to identify which user and device the notification targets.
  * Ensure your webhook endpoint can accept JSON payloads and respond quickly.
  * Treat `device_id` and `user_id` as identifiers and avoid exposing them in user-facing logs or screens.



## Get notifications for a user

Retrieve the notification history for a specific user at a given location.

**Endpoint:** `GET /v3.0/members/{user_id}/push-notifications`

**Params**

  * `page` — Page index, 1-based (default: 1)
  * `limit` — Page size (default: 20, min: 1, max: 100)



**Method:** `GET`

**Content-Type:** `application/json`

**Headers:**
    
    
    {
      "x-glofox-branch-id": "{branch_id}",
      "x-api-key": "{api_key}",
      "x-glofox-api-token": "{api_token}",
      "x-glofox-impersonated-member-id": "{member_id}"
    }

**Response:**
    
    
    {
      "notifications": [
        {
          "_id": "string",
          "branch_id": "string",
          "type": "string",
          "user_id": "string | null",
          "is_marketing": false,
          "message": "string",
          "created": 1718300000,
          "transaction": {
            "id": "string",
            "model": "string",
            "operation": "string"
          }
        }
      ],
      "pagination": {
        "count": 50,
        "perPage": 50,
        "currentPage": 1
      }
    }

Field | Type | Description  
---|---|---  
`_id` | string | Unique identifier for the notification.  
`branch_id` | string | The location the notification belongs to.  
`type` | string | Notification type. `crud_task` for event-driven notifications tied to a data operation; `broadcast` for general messages sent to all or many users.  
`user_id` | string | null | The target user. `null` for broadcast notifications.  
`is_marketing` | boolean | Whether Glofox classifies the notification as a marketing message.  
`message` | string | The notification message body.  
`created` | integer | Unix timestamp for when Glofox created the notification.  
`transaction.id` | string | ID of the related transaction or data record.  
`transaction.model` | string | The data model associated with the triggering event.  
`transaction.operation` | string | The operation that triggered the notification (for example, `create`, `update`).  
`pagination.count` | integer | Total number of notifications returned in this page.  
`pagination.perPage` | integer | Maximum number of results per page.  
`pagination.currentPage` | integer | The current page number.
