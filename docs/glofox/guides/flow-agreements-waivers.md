The **Waiver** and **Terms & Conditions (T&C)** flows currently offer only partial support, as there is no publicly accessible endpoint available to directly initiate these flows.  
  
Agreement email links provide partial support. Glofox automatically generates and sends them when a user registers (for the Waiver flow) or when a member purchases a membership (for the T&C flow). Glofox delivers these links to the user's email address and, when the user opens a link, the corresponding flow starts. Both flows involve an HTTP redirect to a third-party service, where users can review and sign the relevant documents.

## Send agreement emails (`POST`)

To resend the agreement emails, use the following sample request:

  * **Endpoint:** `/2.2/branches/{branch_id}/users/{user_id}/agreements/{agreements_id}/send`
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
      "agreementMetadata": "string"
    }

## Get agreements ID (`GET`)

To retrieve the `agreements_id` for a specific user, use the following endpoint:

  * **Endpoint:** `/2.2/branches/{{x-glofox-branch-id}}/users/{{sample-user-id}}/agreements`
  * **Method:** `GET`
  * **Content-Type:** `application/json`



**Required Headers**
    
    
    {
      "x-glofox-branch-id": "{branch_id}",
      "x-api-key": "{api_key}",
      "x-glofox-api-token": "{api_token}"
    }

**Example Response**
    
    
    {
      "success": true,
      "agreements": [
        {
          "id": "918100a2-1326-4b89-a95e-1426673e6c27",
          "member_id": "62264815aa26217ba57a43f5",
          "studio_id": "6213afed9ead8f3e7b0e3574",
          "document_id": "964f93ed-b4b3-45d9-8e45-ba506d319e04",
          "version": 2,
          "agreed_at": null,
          "platform": "other",
          "status": "outstanding",
          "kind": "signature",
          "provider_document_id": "qWeVPiTRRLzqrWXRMgDG4f",
          "document_url": "https://app.pandadoc.com/s/ofwLKsn7ebdUEvRHBGyUtD",
          "external_reference": "",
          "created_at": "2022-03-07T17:59:51.930173446Z",
          "updated_at": "2022-03-07T18:00:00.409373904Z",
          "previousStatus": "outstanding",
          "provider_status": "ready"
        }
      ]
    }

You can determine whether a user has signed the **Waiver** and/or the **Terms & Conditions** by inspecting the agreements response. In the example below, the user has a single agreement with unsigned status (`status: outstanding`).

The `kind` field returns one of the following:

  * `confirmation`
  * `signature`



For signature agreements, status reflects the signing state with four possible values:

  * `outstanding`
  * `accepted_outdated`
  * `accepted_outdated_requires_new`
  * `accepted`



For agreements with `kind: "confirmation"`, treat them as equivalent to an outstanding signature—the member must sign the associated document. You can enable or turn off emails related to waivers, T&Cs, and similar communications in the **Dashboard** on the **Connect > Messages** option.
