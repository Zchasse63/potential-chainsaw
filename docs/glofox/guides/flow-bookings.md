Use the [Bookings endpoints](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Bookings) to manage bookings and classes. For more information about Classes, access the [Classes section](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Classes) in the API Reference.
    
    
    
    
    ## List available classes (POST)
    
    
    
    
    To retrieve the list of available classes, use the model and model_id fields from the response as follows:
    
    
    
    
    
    
        * **Endpoint:** /2.0/bookings
    
    
        * **Method:** POST
    
    
        * **Content-Type:** application/json
    
    
    
    
    
    **Required Headers**
    
    
    
    
    
    {
      "x-glofox-branch-id": "{branch_id}",
      "x-api-key": "{api_key}",
      "x-glofox-api-token": "{api_token}"
    }

__

Model Assignment Logic

  * If `model_id` is `null`, assign `event._id` to `model_id`.

  * If `model_id` is present, use its value directly.

  * Set the `model` parameter to `event`.




**Request Body**
    
    
    {
      "model": "string",
      "model_id": "string",
      "user_id": "string",
      "payment_method": "string",
      "pay_gym": boolean,
      "guest_bookings": int,
      "charge": boolean
    }

__

Important Parameters for Creating a Booking

  * Include the `guest_bookings` field only when users can bring guests.

  * Set `pay_gym` to `true` only when you collect payment in person. For payments processed through the app, set this field to `false`.

  * The `charge` parameter determines whether Glofox processes the payment. By default, it defaults to `true`. Setting it to false means that the booking goes through regardless of any missing or invalid payment information. Use this only if you process payment on your own platform.




For further details regarding cancellations, access the [cancellation policy](https://support.glofox.com/hc/en-us/articles/360007727297-What-Happens-When-a-Client-Cancels-a-Booking).

## Get streaming link (`GET`)

To obtain the streaming link for an online class, use the following endpoint:

  * **Endpoint:** `/2.0/events/{event_id}?include=facility,model,trainers,program&limit=100`
  * **Method:** `GET`
  * **Content-Type:** `application/json`



**Request Headers:**

**Request Body:**

__

The response includes the`external_provider_stream_url` field.

## Get booking information for users (`GET`)

To retrieve a list of user bookings with detailed information, use:

  * **Endpoint:** `/2.0/bookings?branchId={{x-glofox-branch-id}}&user_id={{sample-user-id}}&include="facility,model,trainers"&sort_by="-time_start&across_branches=true`
  * **Method:** `GET`
  * **Content-Type:** `application/json`



__

If the`image_url` field returns an access denied error, the user has not uploaded an image.

## Waiting list

To join a waiting list, include the field `join_waiting_list: true` in the booking payload.

  * If the user is already on the waiting list, if spots are available, or if the waiting list is full, the request fails.
  * Waiting list promotion settings live in the Dashboard under the Booking tab.



When a user cancels a booking, Glofox automatically books the first user on the waiting list. If the user has available credits or a valid card on file, Glofox processes payment automatically; otherwise, staff must complete the payment.

## Book a trainer (`POST`)

__

Glofox deprecated the trainers model in favor of the appointments model. Verify your version before you implement this flow.

To book a trainer, use the following request:

  * **Endpoint:** `/2.0/bookings`
  * **Method:** `POST`
  * **Content-Type:** `application/json`



**Required Headers**
    
    
    {
      "x-glofox-branch-id": "{branch_id}",
      "x-api-key": "{api_key}",
      "x-glofox-api-token": "{api_token}"
    }

**Request Body**
    
    
    {
      "model": "timeslot",
      "model_id": "624cf36e65167f35063c7f07",
      "user_id": "62264815aa26217ba57a43f5",
      "payment_method": "cash",
      "pay_gym": false,
      "guest_bookings": 0
    }

__

The`model_id` parameter corresponds to the timeslot ID. Retrieve it from the `/2.0/staff/{trainer-user-id}?include=timeslots` endpoint.

__

Finding trainers by email using the legacy API

To search for a trainer by email, use the following legacy endpoint: `https://api.glofox.com/users/listview/1/30/{email}/staff/1`. This endpoint returns an array of users. Glofox may deprecate this legacy endpoint in the future.

## Get booking price with credits (`GET`)

To determine if a user has valid credits for a booking, use the following endpoints:

  * **Events:** `GET /2.0/branches/{branch_id}/events/{event_id}/price?for={user_id}`
  * **timeslot:** `GET /2.0/branches/{branch_id}/appointments/{timeslot_id}/price?for={user_id}`
  * **Courses:** `GET /2.0/branches/{branch_id}/courses/{event_id}/price?for={user_id}`



**Request Response**
    
    
    {
      "success": true,
      "data": {
        "credits": 1,
        "price": 0,
        "currency": "USD"
      }
    }

__

Booking with credits

  * If `price == 0`, the user has sufficient credits and **does not need payment**.

  * If `price > 0`, **the booking requires payment**.

  * To book using credits, submit the **standard booking request** as described in the preceding section.




## Get user credits (`GET`)

To retrieve a user’s credit packs and **total available credits** on the current page:

  * **Endpoint:** `/2.0/credits?user_id={user_id}`
  * **Method:** `GET`
  * **Content-Type:** `application/json`



The response is a paginated list (`object`, `page`, `limit`, `has_more`, `total_count`, `data`). Each credit pack is an object in `data`. Use `page` and `limit` when `has_more` is `true` to fetch additional pages. `total_value` is the sum of `available` across the packs in `data` for that page; per-pack remaining credits are in each item’s `available` field.
