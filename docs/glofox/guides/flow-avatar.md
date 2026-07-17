Retrieving or managing a trainer’s profile avatar within the Glofox platform involves two main operations: fetching the current avatar and uploading a new one. The sections below outline both processes.

## Get avatar (`GET`)

Retrieve the `image_url` for a trainer profile.

  * **Endpoint:** `https://cdn.glofox.com/{ENVIRONMENT}/{NAMESPACE}/branches/{branchId}/users/{userId}/{userId}.png`
  * **Method:** `GET`
  * **Content-Type:** `application/json`



Where you have the following variables:

Field | Description  
---|---  
`ENVIRONMENT` | Specifies the environment context. Use `platform`.  
`NAMESPACE` | Represents the namespace associated with the branch. For the production branch under test, read the namespace from the response of `https://app.glofox.com/2.0/branches/{branchId}`, which the login or registration flow typically returns.  
**branchId** | The unique identifier of the branch for the trainer.  
**userId** | The unique identifier Glofox assigns to the user.  
  
## Upload an avatar (`POST`)

Upload a user's profile avatar.

  * **Endpoint:** `/assets/upload/users/{userId}/profile`
  * **Method:** `POST`
  * **Content-Type:** `application/json`



**Required Headers**
    
    
    {
      "x-glofox-branch-id": "{branch_id}",
      "x-api-key": "{api_key}",
      "x-glofox-api-token": "{api_token}"
    }

**Request Body**
    
    
    Form data: \
