require('dotenv').config()
const DEBUG = process.env.BACKEND_DEBUG === 'true' || process.env.BACKEND_DEBUG === '1'
const config = {
  debug: DEBUG,
  dev: !(process.env.NODE_ENV === 'production'),
  provider: process.env.PROVIDER,
  registrarController: process.env.REGISTRAR_CONTROLLER,
  tld: process.env.TLD || 'country',
  enom: {
    test: process.env.ENOM_LIVE_RESELLER ? (process.env.ENOM_LIVE_RESELLER !== 'true') : DEBUG,
    uid: process.env.ENOM_UID,
    pw: process.env.ENOM_TOKEN,
    ns1: process.env.NS1,
    ns2: process.env.NS2,
    defaultRegistrant: {
      RegistrantFirstName: process.env.REGISTRANT_FIRST_NAME,
      RegistrantLastName: process.env.REGISTRANT_LAST_NAME,
      RegistrantAddress1: process.env.REGISTRANT_ADDRESS1,
      RegistrantCity: process.env.REGISTRANT_CITY,
      RegistrantStateProvince: process.env.REGISTRANT_STATE_PROVINCE,
      RegistrantPostalCode: process.env.REGISTRANT_POSTAL_CODE,
      RegistrantCountry: process.env.REGISTRANT_COUNTRY,
      RegistrantEmailAddress: process.env.REGISTRANT_EMAIL_ADDRESS,
      RegistrantPhone: process.env.REGISTRANT_PHONE,
      RegistrantFax: process.env.REGISTRANT_FAX,
    }
  },
  namecheap: {
    test: process.env.NAMECHEAP_LIVE ? (process.env.NAMECHEAP_LIVE !== 'true') : DEBUG,
    apiUser: process.env.NAMECHEAP_API_USER || process.env.NAMECHEAP_USERNAME,
    apiKey: process.env.NAMECHEAP_API_KEY,
    username: process.env.NAMECHEAP_USERNAME,
    defaultIp: process.env.NAMECHEAP_DEFAULT_IP,
    ns1: process.env.NS1,
    ns2: process.env.NS2,
    defaultRegistrant: {
      RegistrantFirstName: process.env.REGISTRANT_FIRST_NAME,
      RegistrantLastName: process.env.REGISTRANT_LAST_NAME,
      RegistrantAddress1: process.env.REGISTRANT_ADDRESS1,
      RegistrantCity: process.env.REGISTRANT_CITY,
      RegistrantStateProvince: process.env.REGISTRANT_STATE_PROVINCE,
      RegistrantPostalCode: process.env.REGISTRANT_POSTAL_CODE,
      RegistrantCountry: process.env.REGISTRANT_COUNTRY,
      RegistrantEmailAddress: process.env.REGISTRANT_EMAIL_ADDRESS,
      RegistrantPhone: process.env.REGISTRANT_PHONE,
      RegistrantFax: process.env.REGISTRANT_FAX,
      RegistrantOrganizationName: process.env.REGISTRANT_ORG,
      RegistrantJobTitle: process.env.REGISTRANT_JOB_TITLE,
    },
    defaultContact: (contact) => {
      const entries = Object.entries(config.namecheap.defaultRegistrant).map(([k, v]) =>
        [k.replace('Registrant', contact), v])
      return Object.fromEntries(entries)
    },
  },

  verbose: process.env.VERBOSE === 'true' || process.env.VERBOSE === '1',
  https: {
    only: process.env.HTTPS_ONLY === 'true' || process.env.HTTPS_ONLY === '1',
    key: DEBUG ? './certs/test.key' : './certs/privkey.pem',
    cert: DEBUG ? './certs/test.cert' : './certs/fullchain.pem'
  },
  corsOrigins: process.env.CORS,
  secret: process.env.SECRET,

  datastore: {
    gceProjectId: process.env.GCP_PROJECT,
    cred: !process.env.GCP_CRED_PATH ? {} : require(process.env.GCP_CRED_PATH),
    mock: !process.env.GCP_CRED_PATH,
    mockPort: 9000,
    namespace: 'registrar-relay'
  },
}
module.exports = config
