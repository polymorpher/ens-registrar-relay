require('dotenv').config()
require('dotenv').config({ path: '.env.app' })

const DEBUG = process.env.BACKEND_DEBUG === 'true' || process.env.BACKEND_DEBUG === '1'
const config = {
  debug: DEBUG,
  provider: process.env.PROVIDER,
  registrarController: process.env.REGISTRAR_CONTROLLER,
  baseRegistrar: process.env.BASE_REGISTRAR,
  ews: process.env.EWS,
  dc: process.env.DC,
  ewsIp: process.env.EWS_IP,
  easIp: process.env.DEFAULT_MAIL_IP,
  tld: process.env.TLD || 'country',
  allowAdminOverride: process.env.ALLOW_ADMIN_OVERRIDE === 'true',
  registrarProvider: process.env.REGISTRAR_PROVIDER,
  acmeKeyFile: process.env.ACME_KEY_FILE,
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

  datastore: {
    gceProjectId: process.env.GCP_PROJECT,
    cred: !process.env.GCP_DATASTORE_CRED_PATH ? {} : require(process.env.GCP_DATASTORE_CRED_PATH),
    mock: !process.env.GCP_DATASTORE_CRED_PATH,
    mockPort: 9000,
    namespace: 'registrar-relay'
  },

  gcp: {
    gceProjectId: process.env.GCP_PROJECT,
    certificateMapId: process.env.GCP_CERT_MAP || 'dot-country',
    certStorage: {
      projectId: process.env.CERT_STORAGE_GCP_PROJECT,
      bucket: process.env.CERT_STORAGE_BUCKET,
      cred: process.env.CERT_STORAGE_CRED,
    }
  },
  redis: {
    url: process.env.REDIS_URL, // redis[s]://[[username][:password]@][host][:port][/db-number]
  },
  dns: {
    serverApi: process.env.DNS_SERVER_API_ROOT,
    ip: process.env.DEFAULT_A_RECORD_IP,
    soa: process.env.DNS_SOA
      ? JSON.parse(process.env.DNS_SOA)
      : { ttl: 600, min_tll: 300, mname: 'domains.hiddenstate.country.', rname: 'ns1.hiddenstate.xyz.', serial: 1, refresh: 300, retry: 60, expire: 1800 },
    maintainers: JSON.parse(process.env.DNS_MAINTAINERS ?? '[]')
  },
  generator: {
    apiBase: process.env.GENERATOR_API_BASE, // http://ip:8001/
    metadataBucket: process.env.GOOGLE_CLOUD_STORAGE_BUCKET_NAME_METADATA
  },
  redirect: {
    redisUrl: process.env.REDIRECT_REDIS_URL ?? '',
    serverIp: process.env.REDIRECT_SERVER_IP ?? '',
  },
  app: {
    otc: {
      contract: process.env.OTC_CONTRACT ?? '',
      frontendServerIp: process.env.OTC_FRONTEND_SERVER_IP ?? '',
    }
  }
}
module.exports = config
