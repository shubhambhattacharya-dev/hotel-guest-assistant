export interface Bed {
  type: string;
  count: number;
}

export interface Address {
  line1: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  lat?: number;
  lng?: number;
}

export interface Contact {
  phone: string;
  email: string;
}

export interface AccessibilityInfo {
  wheelchairAccessible: boolean;
  accessibleRooms: string[];
  features: string[];
}

export interface TransportationInfo {
  airportDistanceKm: number;
  airportShuttleAvailable: boolean;
  airportShuttleFeePerNight: number;
  parkingCapacity: number;
}

export interface IncidentalsHold {
  amount: number;
  currency: string;
}

export interface Property {
  id: string;
  name: string;
  description: string;
  address: Address;
  contact: Contact;
  checkInTime: string;
  checkOutTime: string;
  timezone: string;
  currency: string;
  starRating?: number;
  totalRooms?: number;
  yearBuilt?: number;
  yearRenovated?: number;
  languagesSpoken?: string[];
  accessibility?: AccessibilityInfo;
  transportation?: TransportationInfo;
  paymentMethods?: string[];
  incidentalsHold?: IncidentalsHold;
  keywords: string[];
}

export interface Room {
  id: string;
  name: string;
  maxOccupancy: number;
  beds: Bed[];
  pricePerNight: number;
  currency: string;
  sizeSqm: number;
  breakfastIncluded: boolean;
  breakfastAddOnPerPersonPerDay: number;
  image?: string;
  view?: string;
  badge?: string;
  description: string;
  features: string[];
  keywords: string[];
}

export interface Amenity {
  id: string;
  name: string;
  type: string;
  description: string;
  details: Record<string, unknown>;
  keywords: string[];
}

export interface Service {
  id: string;
  name: string;
  description: string;
  keywords: string[];
}

export interface Policy {
  id: string;
  title: string;
  policy: string;
  rules?: Record<string, unknown>;
  keywords: string[];
}

export interface Faq {
  id: string;
  question: string;
  answer: string;
  relatedPolicyId?: string;
  relatedAmenityId?: string;
  relatedRoomIds?: string[];
  keywords: string[];
}

export interface HotelData {
  meta?: {
    version: string;
    lastUpdated: string;
    generatedFor: string;
  };
  property: Property;
  rooms: Room[];
  amenities: Amenity[];
  services?: Service[];
  policies: Policy[];
  faqs: Faq[];
}