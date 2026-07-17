Following REST standards, the API may return different HTTP error codes depending on the endpoint and the server’s logic.

## Common error codes

Status Code | Description  
---|---  
**400 Bad Request** | Indicates an issue with the request data, typically caused by invalid input.  
**401 Unauthorized** | The request is not authenticated.  
**403 Forbidden** | The client does not have permission to access the requested resource.  
**404 Not Found** | The requested resource does not exist.  
**429 Too many requests** | The API blocks the request when you exceed the rate limit.  
**500 Internal Server Error** | A generic error indicating a problem on the server side.  
  
__

Important note

Older endpoints sometimes return a 200 status code with a `success` field set to `false`. This indicates some kind of bad request operation. Add a middleware to transform those to 400.

## Error structure

The error response follows a `JSON` structure like this:
    
    
    {
        "message": "Invalid email format",
        "message_code": "INVALID_EMAIL"
    }

Where:

  * **message:** Provides a human-readable explanation of the error.
  * **message_code:** Provides a key for the error that you use on the client side.


