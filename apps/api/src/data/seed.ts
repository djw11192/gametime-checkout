import type { EventRecord, Listing } from "@gametime/contracts";

const DAY = 24 * 60 * 60 * 1000;

function daysOut(days: number, hour: number): string {
  const d = new Date(Date.now() + days * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

export const SEED_EVENTS: EventRecord[] = [
  {
    id: "evt_warriors_lakers",
    name: "Golden State Warriors vs Los Angeles Lakers",
    shortName: "Warriors vs Lakers",
    venueName: "Chase Center",
    city: "San Francisco",
    state: "CA",
    startsAt: daysOut(6, 19),
  },
  {
    id: "evt_hozier",
    name: "Hozier — Unreal Unearth Tour",
    shortName: "Hozier",
    venueName: "The Greek Theatre",
    city: "Berkeley",
    state: "CA",
    startsAt: daysOut(20, 20),
  },
];

export const SEED_LISTINGS: Listing[] = [
  {
    id: "lst_warriors_lower_112",
    eventId: "evt_warriors_lakers",
    section: "112",
    row: "18",
    availableQuantity: 4,
    pricePerTicketCents: 24_500,
    feesPerTicketCents: 3_675,
    deliveryType: "mobile_transfer",
    disclosures: [],
  },
  {
    id: "lst_warriors_upper_224",
    eventId: "evt_warriors_lakers",
    section: "224",
    row: "9",
    availableQuantity: 6,
    pricePerTicketCents: 9_800,
    feesPerTicketCents: 1_470,
    deliveryType: "mobile_transfer",
    disclosures: ["Limited view"],
  },
  {
    id: "lst_hozier_pit_GA",
    eventId: "evt_hozier",
    section: "Pit",
    row: "GA",
    availableQuantity: 2,
    pricePerTicketCents: 18_900,
    feesPerTicketCents: 2_835,
    deliveryType: "mobile_transfer",
    disclosures: ["Standing room only"],
  },
  {
    id: "lst_hozier_terrace_F",
    eventId: "evt_hozier",
    section: "Terrace",
    row: "F",
    availableQuantity: 5,
    pricePerTicketCents: 8_400,
    feesPerTicketCents: 1_260,
    deliveryType: "instant_download",
    disclosures: [],
  },
];
