// config/countries.js - Country configuration
const COUNTRIES = {
    nl: {
      name: 'Netherlands',
      biddingZone: '10YNL----------L',
      stekkerRegion: 'NL',
      currency: 'EUR',
      timezone: 'Europe/Amsterdam',
      defaultVat: 0.21,
      locale: 'nl-NL'
    },
    de: {
      name: 'Germany', 
      biddingZone: '10Y1001A1001A82H',
      stekkerRegion: 'DE-LU',
      currency: 'EUR',
      timezone: 'Europe/Berlin',
      defaultVat: 0.19,
      locale: 'de-DE'
    },
    be: {
      name: 'Belgium',
      biddingZone: '10YBE----------2', 
      stekkerRegion: 'BE',
      currency: 'EUR',
      timezone: 'Europe/Brussels',
      defaultVat: 0.21,
      locale: 'nl-BE'
    },
    fr: {
      name: 'France',
      biddingZone: '10YFR-RTE------C',
      stekkerRegion: 'FR', 
      currency: 'EUR',
      timezone: 'Europe/Paris',
      defaultVat: 0.20,
      locale: 'fr-FR'
    },
    at: {
      name: 'Austria',
      biddingZone: '10YAT-APG------L',
      stekkerRegion: 'AT',
      currency: 'EUR', 
      timezone: 'Europe/Vienna',
      defaultVat: 0.20,
      locale: 'de-AT'
    },
    ch: {
      name: 'Switzerland',
      biddingZone: '10YCH-SWISSGRIDZ',
      stekkerRegion: 'CH',
      currency: 'CHF',
      timezone: 'Europe/Zurich', 
      defaultVat: 0.077,
      locale: 'de-CH'
    },
    dk: {
      name: 'Denmark',
      biddingZone: '10YDK-1--------W', // West Denmark
      stekkerRegion: 'DK1',
      currency: 'DKK',
      timezone: 'Europe/Copenhagen',
      defaultVat: 0.25,
      locale: 'da-DK'
    },
    no: {
      name: 'Norway',
      biddingZone: '10YNO-2--------T', // South-west Norway (most populated)
      stekkerRegion: 'NO2', 
      currency: 'NOK',
      timezone: 'Europe/Oslo',
      defaultVat: 0.25,
      locale: 'nb-NO'
    },
    se: {
      name: 'Sweden',
      biddingZone: '10Y1001A1001A44P', // SE1 - Lulea (Northern Sweden)
      stekkerRegion: 'SE1',
      currency: 'SEK', 
      timezone: 'Europe/Stockholm',
      defaultVat: 0.25,
      locale: 'sv-SE'
    }
  };
  
  module.exports = { COUNTRIES };