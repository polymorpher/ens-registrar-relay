# ENS Registrar Relay

ENS Registrar Relay is a backend server that communicates with web2 registrars on behalf of web3 clients (e.g. browsers). It is designed to work together with ENS contracts deployed by [ENS Deployer](https://github.com/polymorpher/ens-deployer). A reference client implementation is provided in [.country](https://github.com/polymorpher/dot-country) project and a demo is hosted at [names.country](https://names.country)

At this time, the two principal functions of this server are:

1. Checking the availability of a domain (`/check-domain` endpoint)
2. Finalizing the purchase of a domain (`/purchase` endpoint)

Behind the scene, the server perform these functions through one of the following backends.

- [Namecheap API](https://www.namecheap.com/support/api/intro/)
- [enom reseller API](https://api.enom.com/docs)

More backend may be implemented in the future. The server selects which API to use when it starts, and whether it should operate in sandbox mode. Credentials of these APIs are configured at the server.

The server also needs to choose the TLD for incoming requests (e.g. `country` or `com`). At this time, the client cannot choose TLD. Note that, Namecheap API does not support some TLDs in sandbox mode, such as `country`. It is recommended that you set TLD to `com` in sandbox mode if you choose Namecheap API as the backend.

## Domain Availability

Checking availability is a permissionless, read-only operation. Any client can call this endpoint and they would be only subject to rate limits.

### API Usage

```
POST /check-domain

{
    "sld": "polymorpher"
}
```

Where `sld` is the domain name the client wants to check for. If the server configures `country` as the TLD, the request will check the availability of `polymorpher.country`.

Response:

```
{
    "isAvailable": true | false,
    "isReserved": true | false,
    "isRegistered": true | false,
    "regPrice": 10.0,
    "renewPrice": 30.0,
    "transferPrice": 10.0,
    "restorePrice": 100.0,
    "responseText": "The domain is unavailable because it is already taken"
}
```

- **isAvailable**: whether the domain is available for reigistration through API
- **isReserved**: whether the domain is reserved by the registry in some way thereby unavailable for general registration. At this time, premium domains are considered reserved, but this may change soon in the future.
- **isRegistered**: whether the domain is already registered by someone else
- **regPrice**: the cost for register the domain for one year, in USD 
- **renewPrice**: the cost to renew the domain for one year, in USD
- **transferPrice**: the cost to transfer the domain, in USD
- **restorePrice**: the cost to restore the domain within grace period after it is expired, in USD
- **responseText**: any explanation for the result, given by the registrar backend

Response with error (status code !== 200):
```
{
    "error": "....",
    ....other fields for diagnosis...
}
```

## Finalizing Purchase

Finalizing the purchase of a domain requires the client to show proof that a web3 ENS domain is already purchased. The proof consists of the transaction hash, the domain to be purchased, and the purchaser's wallet address. The server will check the following

1. The transaction emitted a NameRegistered event from a server-configured RegistrarController contract address
2. The `NameRegistered` event's `name` and `owner` parameters match with the ones submitted by the client
3. The TLD of the domain submitted by the client matches with the TLD configured at the server
4. The expiration date in `NameRegistered` event is at least one year minus one hour away

The domain name also needs to be no more than 32 characters, and cannot have characters other than alphanumeric characters and `-`

### API Usage

```
POST /purchase
{
    "txHash": "0x07cd47919d33af48345e8bc1c834ede3d81ba0582e7996b35f13c2ca9e4dd2e7",
    "domain": "polymorpher.country",
    "address": "0x32aE45799FE380c5CD76144720E11af990477C3c"
}
```

- **txHash**: the hash of the transaction which resulted in the emission of NameRegistered event. This is usually tbe transaction that calls `register` function directly on RegistrarController (see [reference here](https://github.com/polymorpher/ens-deployer/blob/b95590d3825c7e218f28e95ed10bff03bb8e042e/contract/contracts/RegistrarController.sol#L118)), or indirectly such as through .country (DC) contract, see [reference here](https://github.com/polymorpher/dot-country/blob/3d55d10e6ebdf8f4fa2d93b34621b59eda4bdf71/contracts/contracts/DC.sol#L206).
- **domain**: the fully-qualified domain to register (e.g. `polymorpher.country`). The TLD must match the server-configured TLD, and the domain name (second-level domain) must meet the requirement described above.
- **address** the address of the user who registered the web3 domain in txHash. It is presumed that this address will be renting the domain.

Response:

```
{
    "success": true | false, 
    "domainCreationDate": "2022-12-30 02:58:05.709", 
    "domainExpiryDate": "2023-12-30 02:58:05.709", 
    "responseText": "Command completed successfully - 162774284",
    "traceId": "c255e707-2244-4895-b8c4-591951ac1aa5" | "17668037",
    "reqTime": "12/30/2022 2:58:35 AM"
}
```

- **success**: whether the domain is registered successfully or not
- **domainCreationDate**: optional, a parsable date-time string showing when the domain is officially created in the registry
- **domainExpiryDate**: optional, when the domain will expire in the registry
- **traceId**: the id used at the registrar to identify the transaction. With Namecheap API, this is the transaction id. With enom, this is the command execution traceId.
- **reqTime**: optional, the time when the request was made to the registrar

Response with error (status code !== 200):
```
{
    "error": "....",
    ....other fields for diagnosis...
}
```


## Mock Purchase API

An unrestricted mock API is available for developers to test the domain purchase flow. The API does not check emission of events from any blockchain contract, and directly sends a registration request to the registrar. It is recommended that you only enable this API in sandbox mode.

### Mock API Usage

```
POST /purchase-mock

{
    "domain": "polymorpher.123"
}
```

- **domain**: same as the non-mock version. Note that the TLD part will be ignored. In the example above, the domain to be registered is automatically transformed into `polymorpher.com` if the server configures `.com` as the TLD.

Response: same as the non-mock version


## Server Configurations

You need to put HTTPS certificates under `certs/fullchain.pem` and `certs/privkey.pem` to run the server in non-debug mode. You can generate debug-mode certificates (`certs/test.cert`, `certs/test.key`) using `cd certs; ./gen.sh`  

You need to put a GCP service account key file (JSON format) at `credentials/gcp.json`. The service account must have permission writing to GCP Datastore.

### Environment Variables

- **BACKEND_DEBUG**: (bool) whether to run in debug mode
- **PROVIDER**: the blockchain RPC provider the server uses to verify event emissions. **IMPORTANT**: make sure this is set to mainnet RPC endpoint when running in production
- **TLD**: the top level domain which all requests are checked against. e.g. `country` or `com`
- **ALLOW_ADMIN_OVERRIDE**: (bool) whether to enable mock APIs
- **REGISTRAR_PROVIDER**: which registrar backend to use, must be either `namecheap` or `enom`

#### Domain Registration

- **NS1**: first default name server, used for all domain registrations
- **NS2**: second default name server
- **REGISTRANT_FIRST_NAME**: registrant information
- **REGISTRANT_LAST_NAME**: ditto
- **REGISTRANT_ORG**: ditto, organization name
- **REGISTRANT_JOB_TITLE**: ditto
- **REGISTRANT_ADDRESS1**: ditto
- **REGISTRANT_CITY**: ditto
- **REGISTRANT_STATE_PROVINCE**: ditto (can be either state of province name)
- **REGISTRANT_POSTAL_CODE**: ditto
- **REGISTRANT_COUNTRY**: must be 2-letter country code per ISO 3166
- **REGISTRANT_EMAIL_ADDRESS**: ditto
- **REGISTRANT_PHONE**: must be e.164 format
- **REGISTRANT_FAX**: optional, must be e.164 format

#### enom Related

- **ENOM_LIVE_RESELLER**: (bool) whether to activate live mode for enom requests. If not true, enom requests will be sent to sandbox APIs
- **ENOM_UID**: user id for enom API authentications
- **ENOM_TOKEN**: password or API token, for enom API authentications

#### Namecheap Related

- **NAMECHEAP_LIVE**: (bool) whether to activate live mode for namecheap requests
- **NAMECHEAP_API_USER**: user id for Namecheap. By default, this is the same as the login user id
- **NAMECHEAP_API_KEY**: authentication token for Namecheap
- **NAMECHEAP_USERNAME**: login user id for Namecheap
- **NAMECHEAP_DEFAULT_IP**: A default IPv4 address where the registration comes from, if the server cannot detect user ip. This IP address is submitted to Namecheap, which they may use to prevent spamming

#### Server Configurations

- **CORS**: the value to set in `Access-Control-Allow-Origin` response header. Use `*` to automatically adopt the value of request's origin
- **GCP_PROJECT**: GCP project id, for persisting records of successful domain purchases
- **GCP_CRED_PATH**: path of the GCP service account key file
