This guide describes how to retrieve, manage, and tokenize user payment methods using the Glofox API. It outlines the steps for accessing stored credit cards, known as `cards`, and bank debit payment mandates, known as `mandates`, and payment history. It also explains how to initiate the payment collector flow, which securely allows users to add new payment methods.

The payment collector uses a secure iframe that handles card and mandate entry, validation, and tokenization. Your app never handles sensitive payment information directly, which helps you stay compliant with Payment Card Industry Data Security Standard requirements.

![Payment collector](/glofox/markdown-docs/flows/payment-collector.png)

Access the [Payments section](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Payments/paths/~12.1~1branches~1%7BbranchId%7D~1payment-methods/get) in the API Reference for comprehensive details on retrieving the payment methods available to a user.

## Get credit card (`GET`)

Retrieve the credit card associated with a specific user.

  * **Endpoint:** `/2.1/branches/{{x-glofox-branch-id}}/users/{{sample-user-id}}/cards`
  * **Method:** `GET`
  * **Content-Type:** `application/json`



**Required Headers**
    
    
    {
      "x-glofox-branch-id": "{branch_id}",
      "x-api-key": "{api_key}",
      "x-glofox-api-token": "{api_token}"
    }

## Get debit mandate (`GET`)

Retrieve the bank debit mandates for a specific user (`mandates`).

  * **Endpoint:** `/2.1/branches/{{x-glofox-branch-id}}/users/{{sample-user-id}}/mandates`
  * **Method:** `GET`
  * **Content-Type:** `application/json`



**Required Headers**
    
    
    {
      "x-glofox-branch-id": "{branch_id}",
      "x-api-key": "{api_key}",
      "x-glofox-api-token": "{api_token}"
    }

## Get payment history (`GET`)

Retrieve a user's payment history.

  * **Endpoint:** `/2.0/charges?user_id={{sample-user-id}}&page=1&sort_by=-created&include=model&across_branches=true&limit=100`
  * **Method:** `GET`
  * **Content-Type:** `application/json`



**Required Headers**
    
    
    {
      "x-glofox-branch-id": "{branch_id}",
      "x-api-key": "{api_key}",
      "x-glofox-api-token": "{api_token}"
    }

__

Each user can register only one payment method per type. For example, a user may register a single credit card and a single debit card concurrently.

## Payment collector flow

Implement the payment collector according to the workflow outlined in the following steps.

### Step 1

Invoke the payment collector endpoint to retrieve the payment collector iframe URL. The payment-methods endpoint returns this URL in its response.

  * **Endpoint:** `/2.1/branches/{branch_id}/payment-methods?includes=provider,iframe`
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
      "data": [
        {
          "_id": "5bcf7347250c89a421d4561e",
          "branch_id": "570b795c778f3bbd138b4568",
          "active": true,
          "staff_only": false,
          "type_id": "CARD",
          "account_management_link": null,
          "same_card_and_dd": false,
          "provider": {
            "id": "5f4758e8af36710a928afc4b",
            "name": "STRIPE_CUSTOM_EU",
            "charge_percentage": 5,
            "is_charge_percentage_editable": true,
            "fixed_charge": 1,
            "is_fixed_charge_editable": true,
            "publishable_key": "pk_test_1loGihTKRmyb83crV9eKxhsv",
            "account_id": "3",
            "tokenization_handler": "STRIPE",
            "gateway_migration_state": null,
            "features": []
          },
          "iframe": {
            "parameters": {
              "color_accent": null,
              "color_background": null,
              "color_text": null
            },
            "domain": "https://development.glofox.com",
            "full_path": "/payment-collector/#/branch/570b795c778f3bbd138b4568/tokenizationMethod/stripe/tokenizationKey/pk_test_1loGihTKRmyb83crV9eKxhsv/payment-collector?colors[background]=FFFFFF&colors[accent]=000000&colors[text]=508B4B&transparent_background=0&user[id]=5b9a8224953e0d018e357a32&user[first_name]=Jane&user[last_name]=Smith&user[phone]=+15550001111&user[email]=member%40example.com&user[country]=IRL&user[currency]=EUR&branch[name]=Cookie%2BStudio&branch[address]=Alameda%2Bdel%2Bcorregidor%2B550%2Bdpto%2BA&branch[city]=Lima&branch[postal]=15024&branch[state]=Lima&branch[country]=IE&branch[phone]=089951436&branch[email]=branch%40example.com&branch[id]=570b795c778f3bbd138b4568&account_id=3"
          }
        }
      ]
    }

### Step 2

Render an iframe using the URL obtained in the previous step. Construct the iframe URL by concatenating `data[i].iframe.domain` with `data[i].iframe.full_path`. Issuing a GET request to this constructed iframe URL loads the card collector interface, enabling users to enter card or mandate details. Upon successful entry and validation of these details, the tokenization process starts.

### Step 3

Monitor the completion of the tokenization process and retrieve the resulting token by using the `postMessage` API. Attach an onload handler to the payment collector iframe, send a registration message to register the parent window for tokenization callbacks, and then listen for message events to receive the token.

__

Using`postMessage` Listener

Once the iframe loads, register for tokenization callbacks and listen for message events to capture the token.

#### Web app integration example

Host the container page on an authorized domain. For local development, the following URLs are pre-authorized: `http://localhost`, `http://localhost:8080`. The example below demonstrates how to add an onload event handler to the payment collector iframe, register the parent window for tokenization callbacks, and listen for messages containing the token:
    
    
    <iframe id="paymentCollectorIframe"
            src="IFRAME_URL_FROM_PAYMENT_METHODS_ENDPOINT"
            onload="setupIframeCommunication()"
            style="width: 500px; height: 700px;"
            frameborder="0">
    </iframe>
    
    <script>
        // Establish communication with the iframe after it has loaded
        function setupIframeCommunication() {
            const iframe = document.getElementById('paymentCollectorIframe');
            const targetOrigin = data[i].iframe.domain; // The iframe's domain
    
            // Register the parent window for callbacks using postMessage
            // Consider using a timer or interval to ensure the iframe is fully loaded
            iframe.contentWindow.postMessage('register parent', targetOrigin);
    
            // Listen for messages from the iframe
            window.addEventListener('message', function(event) {
                // Validate the message origin
                if (event.origin === targetOrigin) {
                    console.log('Message received from iframe:', event.data);
                    // Handle the token and options received from the iframe here
                }
            }, false);
        }
    </script>

Replace `IFRAME_URL_FROM_PAYMENT_METHODS_ENDPOINT` with the actual iframe URL obtained from the payment-methods endpoint.

This example illustrates the essential steps for implementing iframe communication in web applications, ensuring secure and dynamic interaction with the payment collector.

__

Important

To utilize the payment collector, authorize your domain first.

The Glofox API support team handles domain authorization.

Contact [glofox.apisupport@abcfitness.com](mailto:glofox.apisupport@abcfitness.com) to request domain authorization.

### Step 4

Submit the token and options to the appropriate endpoint to save the new card or mandate. After you obtain the token and options, send them to the relevant endpoint in the Glofox API to register the new payment method.

#### Cards endpoint

  * **Endpoint:** `/2.1/branches/{branch_id}/users/{user_id}/cards`
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
      "card_token": "string",
      "options": {}
    }

#### Mandates endpoint

  * **Endpoint:** `/2.1/branches/{branch_id}/users/{user_id}/mandates`
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
      "mandate_token": "string",
      "options": {}
    }

## Membership purchase after adding a card

After the user has completed the payment collector flow, added a card or mandate, and chosen a membership plan, complete the purchase with the membership purchase endpoint. That call charges the stored payment method for the selected plan.

  * **API Reference:** [Purchase membership plan](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Memberships/paths/~12.2~1branches~1%7BbranchId%7D~1users~1%7BuserId%7D~1memberships~1%7BmembershipId%7D~1plans~1%7BplanCode%7D~1purchase/post)
  * **Endpoint:** `POST` `/2.2/branches/{branch_id}/users/{user_id}/memberships/{membership_id}/plans/{plan_code}/purchase`



## Membership price breakdown (cart)

For a correct price breakdown before purchase, including taxes, fees, and totals, use the cart **pre-checkout** endpoint instead of relying only on catalog or UI display values.

  * **API Reference:** [Pre-checkout cart](https://api-portal.glofox.com/api-portal/glofox/api/openapi-reference.html#tag/Cart/paths/~1v2.0~1carts~1pre-checkout/post)
  * **Endpoint:** `POST` `/v2.0/carts/pre-checkout`



## Purchasing products

Product purchases use the cart APIs in a separate flow: list products, create a cart, then check out. See [Purchase product](/glofox/flows/purchase-product) for step-by-step details, API Reference links, cart ownership, and restrictions such as no mixed product-and-membership carts.
