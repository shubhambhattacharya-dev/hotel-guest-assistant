"use client";

import React, { useState, useRef, useEffect } from "react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  MessageSquare,
  BedDouble,
  Sparkles,
  FileText,
  MapPin,
  Search,
  Sun,
  Send,
  Paperclip,
  Clock,
  Waves,
  Coffee,
  Calendar,
  Users,
  X,
  Wifi,
  Ban,
  Quote,
  RefreshCw,
  AlertCircle,
  Bot
} from "lucide-react";

interface RoomOption {
  id: string;
  name: string;
  maxOccupancy: number;
  beds?: Array<{ type: string; count: number }> | string;
  pricePerNight: number;
  currency?: string;
  availableRooms?: number;
  description?: string;
  image?: string;
  badge?: string;
  breakfastIncluded?: boolean;
}

interface AvailabilityData {
  available: boolean;
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: RoomOption[];
  message?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  availabilityData?: AvailabilityData | null;
  toolUsed?: string | null;
}

interface HotelProperty {
  id: string;
  name: string;
  description: string;
  address: {
    line1: string;
    city: string;
    state: string;
    zip: string;
    country: string;
  };
  contact: {
    phone: string;
    email: string;
  };
  checkInTime: string;
  checkOutTime: string;
  timezone: string;
  currency: string;
  starRating?: number;
  totalRooms?: number;
  languagesSpoken?: string[];
  paymentMethods?: string[];
  keywords: string[];
}

interface HotelData {
  property: HotelProperty;
  rooms: RoomOption[];
  amenities: Array<{
    id: string;
    name: string;
    type: string;
    description: string;
    details: Record<string, unknown>;
    keywords: string[];
  }>;
  services?: Array<{
    id: string;
    name: string;
    description: string;
    keywords: string[];
  }>;
  policies: Array<{
    id: string;
    title: string;
    policy: string;
    rules?: Record<string, unknown>;
    keywords: string[];
  }>;
  faqs: Array<{
    id: string;
    question: string;
    answer: string;
    keywords: string[];
  }>;
}

/* ────────────────── AVAILABILITY FORM TRIGGER ──────────────────
 * The assignment requires a usable way to collect check-in date,
 * check-out date, and number of guests whenever availability is
 * requested.
 *
 * Detection of availability intent is owned ENTIRELY by the
 * backend agent (isUndatedAvailabilityRequest in
 * agentOrchestrator.ts). When the backend cannot run a check
 * because dates are missing, it responds with
 * metadata.requiresAvailabilityForm and this UI opens the inline
 * form below — one source of truth, no mirrored regexes here.
 */

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
};

/** Pull a guest count out of the message so the form can be prefilled. */
function extractGuestCount(text: string): number | undefined {
  const numeric = text.match(/\b(\d{1,2})\s*(?:adults?|guests?|people|persons?)\b/i);
  if (numeric) {
    const count = Number(numeric[1]);
    if (count >= 1 && count <= 6) return count;
  }
  const word = text.match(
    /\b(one|two|three|four|five|six)\s*(?:adults?|guests?|people|persons?)\b/i,
  );
  if (word) return WORD_NUMBERS[word[1].toLowerCase()];
  return undefined;
}

function toISODate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function nextDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return toISODate(date);
}

function formatTime24to12(time24: string): string {
  const [hours, minutes] = time24.split(":");
  const h = parseInt(hours, 10);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${minutes} ${period}`;
}

function getBreakfastSummary(data: HotelData): string {
  const policy = data.policies.find((p) => p.id === "breakfast_inclusion");
  if (policy && policy.rules) {
    const included = (policy.rules.includedForRoomIds as string[]) || [];
    const addOn = (policy.rules.addOnForRoomIds as string[]) || [];
    const addOnPrice = policy.rules.addOnPricePerPersonPerDay;
    const parts: string[] = [];
    if (included.length > 0) {
      parts.push(`Included with ${included.map((id) => data.rooms.find((r) => r.id === id)?.name || id).join(", ")}`);
    }
    if (addOn.length > 0 && addOnPrice) {
      parts.push(`$${addOnPrice}/day for ${addOn.map((id) => data.rooms.find((r) => r.id === id)?.name || id).join(", ")}`);
    }
    if (parts.length > 0) return parts.join("; ");
  }
  const includedCount = data.rooms.filter((r) => r.breakfastIncluded === true).length;
  return `${includedCount} room type${includedCount !== 1 ? "s include" : " includes"} breakfast`;
}

function getAmenitySummary(data: HotelData, amenityId: string): string {
  const amenity = data.amenities.find((a) => a.id === amenityId);
  if (!amenity) return "Contact front desk";
  const details = amenity.details as Record<string, unknown>;
  if (amenityId === "pool" && details.heated) {
    const open = details.openingTime as string;
    const close = details.closingTime as string;
    return `Yes, ${details.location} heated pool (${formatTime24to12(open)} - ${formatTime24to12(close)})`;
  }
  if (amenityId === "wifi" && details.complimentary) {
    return `Free, up to ${details.maximumSpeedMbps} Mbps`;
  }
  return amenity.description;
}

function getPolicySummary(data: HotelData, policyId: string): string {
  const policy = data.policies.find((p) => p.id === policyId);
  if (!policy) return "Contact front desk";
  if (policyId === "pets") {
    const rules = policy.rules as Record<string, unknown>;
    if (rules.allowed) {
      return `Pets allowed (up to ${rules.maxWeightLbs} lbs, $${
        rules.cleaningFeePerStay
      } fee, max ${rules.maxPetsPerRoom} pets)`;
    }
    return "Not allowed";
  }
  return policy.policy;
}

/**
 * Styled Markdown renderers for assistant messages.
 *
 * The concierge model answers with light Markdown (bold room names,
 * bullet lists, occasional GFM tables). These mappings keep every
 * construct on the luxury design system instead of showing raw syntax.
 */
const markdownComponents = {
  p: (props: React.ComponentProps<"p">) => (
    <p className="mb-2 last:mb-0 leading-relaxed" {...props} />
  ),
  strong: (props: React.ComponentProps<"strong">) => (
    <strong className="font-semibold text-[#1a2d28]" {...props} />
  ),
  em: (props: React.ComponentProps<"em">) => (
    <em className="italic text-[#3b4742]" {...props} />
  ),
  ul: (props: React.ComponentProps<"ul">) => (
    <ul className="list-disc pl-4 my-2 space-y-1" {...props} />
  ),
  ol: (props: React.ComponentProps<"ol">) => (
    <ol className="list-decimal pl-4 my-2 space-y-1" {...props} />
  ),
  li: (props: React.ComponentProps<"li">) => <li className="leading-relaxed" {...props} />,
  h1: (props: React.ComponentProps<"h1">) => (
    <h1 className="text-sm font-bold text-[#1a2d28] my-2 first:mt-0" {...props} />
  ),
  h2: (props: React.ComponentProps<"h2">) => (
    <h2 className="text-sm font-bold text-[#1a2d28] my-2 first:mt-0" {...props} />
  ),
  h3: (props: React.ComponentProps<"h3">) => (
    <h3 className="text-xs font-bold text-[#1a2d28] my-2 first:mt-0" {...props} />
  ),
  h4: (props: React.ComponentProps<"h4">) => (
    <h4 className="text-xs font-bold text-[#1a2d28] my-2 first:mt-0" {...props} />
  ),
  a: (props: React.ComponentProps<"a">) => (
    <a className="text-[#24423b] font-medium underline underline-offset-2" target="_blank" rel="noreferrer" {...props} />
  ),
  code: (props: React.ComponentProps<"code">) => (
    <code className="bg-[#ece7da] rounded px-1 py-0.5 text-[11px] text-[#1e3a34]" {...props} />
  ),
  blockquote: (props: React.ComponentProps<"blockquote">) => (
    <blockquote className="border-l-2 border-[#beb4a2] pl-3 my-2 text-[#3b4742] italic" {...props} />
  ),
  hr: () => <hr className="border-[#ded8cb] my-3" />,
  table: (props: React.ComponentProps<"table">) => (
    <div className="my-2 overflow-x-auto rounded-xl border border-[#ded8cb]">
      <table className="w-full text-[11px] border-collapse" {...props} />
    </div>
  ),
  thead: (props: React.ComponentProps<"thead">) => (
    <thead className="bg-[#ece7da] text-[#1e3a34]" {...props} />
  ),
  th: (props: React.ComponentProps<"th">) => (
    <th className="text-left font-semibold px-2.5 py-1.5 border-b border-[#ded8cb]" {...props} />
  ),
  td: (props: React.ComponentProps<"td">) => (
    <td className="px-2.5 py-1.5 border-b border-[#efeade] align-top" {...props} />
  ),
};

function formatHumanDate(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Inline availability collector rendered on demand above the input bar.
 * Backend validation (AvailabilityService) accepts 1–6 adults, so the
 * dropdown is kept inside that range.
 */
function AvailabilityForm({
  initialAdults,
  onClose,
  onSubmit,
}: {
  initialAdults: number;
  onClose: () => void;
  onSubmit: (checkIn: string, checkOut: string, adults: number) => void;
}) {
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [adults, setAdults] = useState(initialAdults);
  const todayStr = toISODate(new Date());

  const nights =
    checkIn && checkOut
      ? Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86_400_000)
      : 0;
  const isValid = Boolean(checkIn && checkOut && nights >= 1);

  const handleCheckInChange = (value: string) => {
    setCheckIn(value);
    if (value && (!checkOut || checkOut <= value)) {
      setCheckOut(nextDay(value));
    }
  };

  return (
    <div className="max-w-4xl mx-auto mb-3 bg-[#f8f6f0] border border-[#d6cfbe] rounded-2xl p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3.5">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-[#ece7da] text-[#2d4941]">
            <Calendar className="w-4 h-4" />
          </div>
          <div>
            <p className="text-xs font-bold text-[#1a2d28] tracking-tight">Check Room Availability</p>
            <p className="text-[10px] text-[#6e7b75]">Tell us your stay dates and party size</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-lg text-[#8b9a92] hover:text-[#1a2d28] hover:bg-[#ece7da] transition"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
        <label className="block">
          <span className="text-[10px] font-semibold text-[#5c6862] uppercase tracking-wide">
            Check-in
          </span>
          <input
            type="date"
            value={checkIn}
            min={todayStr}
            onChange={(e) => handleCheckInChange(e.target.value)}
            className="mt-1 w-full bg-white border border-[#d6cfbe] rounded-xl px-3 py-2 text-xs text-[#20312b] outline-none focus:border-[#24423b] focus:ring-2 focus:ring-[#24423b]/10 transition"
          />
        </label>

        <label className="block">
          <span className="text-[10px] font-semibold text-[#5c6862] uppercase tracking-wide">
            Check-out
          </span>
          <input
            type="date"
            value={checkOut}
            min={checkIn ? nextDay(checkIn) : todayStr}
            onChange={(e) => setCheckOut(e.target.value)}
            className="mt-1 w-full bg-white border border-[#d6cfbe] rounded-xl px-3 py-2 text-xs text-[#20312b] outline-none focus:border-[#24423b] focus:ring-2 focus:ring-[#24423b]/10 transition"
          />
        </label>

        <label className="block">
          <span className="text-[10px] font-semibold text-[#5c6862] uppercase tracking-wide">
            Guests
          </span>
          <div className="mt-1 relative">
            <Users className="w-3.5 h-3.5 text-[#798881] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <select
              value={adults}
              onChange={(e) => setAdults(Number(e.target.value))}
              className="w-full bg-white border border-[#d6cfbe] rounded-xl pl-8 pr-3 py-2 text-xs text-[#20312b] outline-none focus:border-[#24423b] focus:ring-2 focus:ring-[#24423b]/10 transition appearance-none"
            >
              {[1, 2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "adult" : "adults"}
                </option>
              ))}
            </select>
          </div>
        </label>
      </div>

      <div className="flex items-center justify-between mt-3.5">
        <p className="text-[10px] text-[#6e7b75]">
          {isValid
            ? `${nights} night${nights > 1 ? "s" : ""} · ${adults} ${adults === 1 ? "adult" : "adults"}`
            : "Select check-in and check-out dates to continue"}
        </p>
        <button
          type="button"
          disabled={!isValid}
          onClick={() => onSubmit(checkIn, checkOut, adults)}
          className="flex items-center gap-1.5 bg-[#24423b] hover:bg-[#1a332d] disabled:opacity-40 disabled:cursor-not-allowed text-white text-[11px] font-semibold px-4 py-2 rounded-xl transition"
        >
          <Search className="w-3.5 h-3.5" />
          Search Availability
        </button>
      </div>
    </div>
  );
}

export default function GrandviewHotelApp() {
  const [messages, setMessages] = useState<Message[]>([
    {
      id: "welcome-assistant",
      role: "assistant",
      content:
        "Hi there! 👋\n\nI'm your AI hotel assistant. Ask me anything about our hotel, rooms, amenities, policies, or check availability for your stay. I'll help you find the perfect experience.\n\nYour perfect stay starts here.",
      timestamp: "Now",
    },
  ]);
  const [conversationId, setConversationId] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem("hotel_conversation_id");
    } catch {
      return null;
    }
  });
  const [lastFailedMessage, setLastFailedMessage] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("chat");
  const [showAvailabilityForm, setShowAvailabilityForm] = useState(false);
  const [availabilityFormAdults, setAvailabilityFormAdults] = useState(2);
  const [hotelData, setHotelData] = useState<HotelData | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const backendUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

  const scrollToBottom = () => {
    if (messagesEndRef.current) {
      const parent = messagesEndRef.current.parentElement;
      if (parent) {
        parent.scrollTop = 0;
      } else {
        messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
      }
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  useEffect(() => {
    async function loadHotelData() {
      try {
        const res = await fetch(`${backendUrl}/api/hotel`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json();
          setHotelData(data);
        }
      } catch {
        // non-blocking: UI falls back to minimal content
      }
    }
    loadHotelData();
  }, [backendUrl]);

  const quickQuestions = [
    { label: "What time is check-in?", icon: Clock },
    { label: "Do you have a swimming pool?", icon: Waves },
    { label: "Is breakfast included?", icon: Coffee },
    { label: "Check room availability", icon: Calendar },
    { label: "Cancellation policy", icon: FileText },
    { label: "Which room is good for 3 guests?", icon: Users },
  ];

  const handleSend = async (textToSend?: string) => {
    const query = (textToSend || input).trim();
    if (!query || isLoading) return;

    const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: "user",
      content: query,
      timestamp,
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setErrorMessage(null);

     try {
      const res = await fetch(`${backendUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: query,
          conversationId: conversationId || undefined,
          history: messages
            .filter((m) => m.id !== "welcome-assistant")
            .slice(-6)
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok) {
        /**
         * The backend returns structured errors:
         *   503 + code "llm_not_configured" | "all_llm_providers_failed"
         *   400 validation, 500 unexpected.
         * Surface the server's own message so an AI/LLM failure is
         * reported honestly instead of looking like a network issue.
         */
        let serverError = `Server returned ${res.status}`;
        try {
          const errBody = await res.json();
          if (errBody?.error) serverError = errBody.error;
        } catch {
          // error body was not JSON; keep the generic status message
        }
        throw new Error(serverError);
      }

      const data = await res.json();

      if (data.conversationId) {
        setConversationId(data.conversationId);
        try {
          sessionStorage.setItem("hotel_conversation_id", data.conversationId);
        } catch {
          // sessionStorage unavailable
        }
      }
      setLastFailedMessage(null);

      const rawAvailability: AvailabilityData | null =
        data.metadata?.availabilityData || null;

      const availabilityData: AvailabilityData | null = rawAvailability
        ? {
            ...rawAvailability,
            rooms: Array.isArray(rawAvailability.rooms)
              ? rawAvailability.rooms.map((r: RoomOption) => ({
                  ...r,
                  image: r.image || undefined,
                  badge: r.badge || undefined,
                }))
              : [],
          }
        : null;

      const asstMessage: Message = {
        id: `asst-${Date.now()}`,
        role: "assistant",
        content: data.message?.content || data.fallback || "I am glad to assist you.",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        availabilityData,
        toolUsed: data.metadata?.toolUsed || null,
      };

      setMessages((prev) => [...prev, asstMessage]);

      // The backend signals this when the agent detects an availability
      // request it cannot run yet (e.g. a phrasing the client-side check
      // missed). Same form, prefilled from conversation entities.
      if (data.metadata?.requiresAvailabilityForm) {
        setAvailabilityFormAdults(
          data.metadata?.availabilityFormPrefill?.adults ?? extractGuestCount(query) ?? 2,
        );
        setShowAvailabilityForm(true);
      }
    } catch (err) {
      setLastFailedMessage(query);
      const message = err instanceof Error ? err.message : "";
      const isNetworkFailure =
        !message || /failed to fetch|load failed|networkerror|aborted/i.test(message);

      setErrorMessage(
        isNetworkFailure
          ? "Unable to connect to hotel services. Please verify backend is running on port 8000."
          : message,
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleAvailabilitySearch = (checkIn: string, checkOut: string, adults: number) => {
    if (isLoading) return;
    setShowAvailabilityForm(false);
    handleSend(
      `Do you have rooms available from ${formatHumanDate(checkIn)} to ${formatHumanDate(checkOut)} for ${adults} ${
        adults === 1 ? "adult" : "adults"
      }?`,
    );
  };

  const openAvailabilityForm = (adults = 2) => {
    setAvailabilityFormAdults(adults);
    setShowAvailabilityForm(true);
  };

  return (
    <div className="flex h-screen w-full bg-[#fdfbf7] text-[#2d312e] font-sans antialiased overflow-hidden">
      {/* ────────────────── LEFT SIDEBAR ────────────────── */}
      <aside className="w-64 bg-[#f8f6f0] border-r border-[#ece8df] hidden lg:flex flex-col justify-between flex-shrink-0">
        <div>
          {/* Hotel Brand Logo */}
          <div className="p-6 flex items-center gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center">
              {/* Lotus Brand SVG Icon */}
              <svg viewBox="0 0 100 100" className="w-8 h-8 text-[#1e3a34] fill-none stroke-current stroke-[4]">
                <path d="M50 20 C40 35 30 55 50 80 C70 55 60 35 50 20 Z" />
                <path d="M50 80 C30 75 15 50 25 35 C35 38 45 55 50 80 Z" />
                <path d="M50 80 C70 75 85 50 75 35 C65 38 55 55 50 80 Z" />
              </svg>
            </div>
            <div>
              <h1 className="font-serif text-lg font-bold tracking-tight text-[#1b2a26] leading-tight">
                {hotelData ? hotelData.property.name.replace(/^The\s+/i, "").split(" ")[0] : "Grandview"}
              </h1>
              <p className="text-[10px] tracking-widest text-[#7a8580] uppercase font-medium">
                Hotel & Resort
              </p>
            </div>
          </div>

          {/* Navigation Items */}
          <nav className="px-3 space-y-1 mt-2">
            <button
              onClick={() => setActiveTab("chat")}
              className={`w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-medium transition ${
                activeTab === "chat"
                  ? "bg-[#ede8dc] text-[#1b2a26] shadow-sm font-semibold"
                  : "text-[#626e68] hover:bg-[#ede8dc]/50 hover:text-[#1b2a26]"
              }`}
            >
              <MessageSquare className="w-4 h-4 text-[#2d4941]" />
              <span>Chat Assistant</span>
            </button>

            <button
              onClick={() => handleSend("Tell me about your rooms")}
              className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-medium text-[#626e68] hover:bg-[#ede8dc]/50 hover:text-[#1b2a26] transition"
            >
              <BedDouble className="w-4 h-4 text-[#626e68]" />
              <span>Explore Rooms</span>
            </button>

            <button
              onClick={() => handleSend("What amenities do you have?")}
              className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-medium text-[#626e68] hover:bg-[#ede8dc]/50 hover:text-[#1b2a26] transition"
            >
              <Sparkles className="w-4 h-4 text-[#626e68]" />
              <span>Hotel Amenities</span>
            </button>

            <button
              onClick={() => handleSend("What is your cancellation and check-in policy?")}
              className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-medium text-[#626e68] hover:bg-[#ede8dc]/50 hover:text-[#1b2a26] transition"
            >
              <FileText className="w-4 h-4 text-[#626e68]" />
              <span>Policies & FAQs</span>
            </button>

            <button
              onClick={() => handleSend("What is the hotel location and address?")}
              className="w-full flex items-center gap-3 px-4 py-2.5 rounded-xl text-xs font-medium text-[#626e68] hover:bg-[#ede8dc]/50 hover:text-[#1b2a26] transition"
            >
              <MapPin className="w-4 h-4 text-[#626e68]" />
              <span>Location & Contact</span>
            </button>
          </nav>
        </div>

        {/* Lower Left Promo Card with Palm Tree & Pool Image */}
        <div className="p-3">
          <div className="relative h-64 rounded-2xl overflow-hidden shadow-sm group">
            <Image
              src="/left upper side image.png"
              alt="Resort Pool"
              fill
              className="object-cover transition-transform duration-700 group-hover:scale-105"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent flex flex-col justify-end p-4 text-center">
              <span className="text-[10px] tracking-widest text-[#f5eedc] uppercase font-semibold">
                More Than
              </span>
              <span className="text-xs font-serif tracking-wider text-white uppercase font-bold mt-0.5">
                A Stay
              </span>
              <span className="text-[10px] tracking-widest text-[#d8cfbe] uppercase font-medium mt-1">
                A Brighter You
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* ────────────────── MAIN CHAT AREA ────────────────── */}
      <main className="flex-1 flex flex-col min-w-0 bg-[#ffffff] relative">
        {/* Top Navbar */}
        <header className="h-16 border-b border-[#f0ece3] px-4 sm:px-8 flex items-center justify-between bg-white/80 backdrop-blur-md z-10">
          <div className="hidden md:flex items-center gap-8 text-xs font-medium text-[#5c6862]">
            <button className="text-[#1e3a34] font-semibold">Stay</button>
            <button className="hover:text-[#1e3a34] transition">Dine</button>
            <button className="hover:text-[#1e3a34] transition">Wellness</button>
            <button className="hover:text-[#1e3a34] transition">Experiences</button>
            <button className="hover:text-[#1e3a34] transition">About</button>
          </div>

          <div className="flex items-center gap-4">
            <button className="p-2 text-[#65736c] hover:text-[#1e3a34] rounded-full hover:bg-zinc-100 transition">
              <Search className="w-4 h-4" />
            </button>
            <button className="p-2 text-[#65736c] hover:text-[#1e3a34] rounded-full hover:bg-zinc-100 transition">
              <Sun className="w-4 h-4" />
            </button>
            <button
              onClick={() => openAvailabilityForm(2)}
              className="bg-[#24423b] hover:bg-[#1a332d] text-white text-xs font-medium px-4 py-2 rounded-xl transition shadow-sm"
            >
              Book a Room
            </button>
            <div className="flex items-center gap-2.5 pl-2 border-l border-[#ebe6dc]">
              <div className="relative w-8 h-8 rounded-full bg-[#edeae1] border border-[#dcd6c7] flex items-center justify-center text-[#24423b]">
                <Bot className="w-4 h-4" />
                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-500 border-2 border-white"></span>
              </div>
              <div className="text-left hidden sm:block">
                <p className="text-xs font-semibold text-[#1e3a34] leading-none">
                  Guest Assistant
                </p>
                <p className="text-[10px] text-emerald-600 font-medium mt-0.5">
                  Always here for you
                </p>
              </div>
            </div>
          </div>
        </header>

        {/* Scrollable Conversation Content */}
        <div className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 space-y-6">
          {/* Welcome Header */}
          <div className="relative pb-2">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-3xl font-bold tracking-tight text-[#1a2d28] font-serif flex items-center gap-2">
                  Hi there! <span className="animate-wave inline-block origin-bottom-right">👋</span>
                </h2>
                <h3 className="text-2xl font-bold tracking-tight text-[#1a2d28] mt-1 font-serif">
                  I&apos;m your AI hotel assistant
                </h3>
                <p className="text-xs text-[#6e7b75] mt-2 max-w-xl leading-relaxed">
                  Ask me anything about our hotel, rooms, amenities, policies, or check availability
                  for your stay. I&apos;ll help you find the perfect experience.
                </p>
              </div>

              {/* Hand-drawn scribble accent */}
              <div className="hidden lg:block text-right pr-6 pt-1 text-[#62766f]">
                <span className="font-serif italic text-sm tracking-wide block">
                  Your perfect
                </span>
                <span className="font-serif italic text-sm tracking-wide block -mt-1">
                  stay starts here
                </span>
                <svg className="w-16 h-4 ml-auto text-[#889b94]" viewBox="0 0 100 25" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10 5 Q 50 25 85 10 L 80 5 M 85 10 L 75 15" strokeLinecap="round" />
                </svg>
              </div>
            </div>

            {/* Quick Question Badges */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 mt-5">
              {quickQuestions.map((q, idx) => {
                const Icon = q.icon;
                return (
                  <button
                    key={idx}
                    onClick={() => handleSend(q.label)}
                    className="flex items-center gap-2 px-3.5 py-2 rounded-full border border-[#ded8cb] bg-[#faf8f4] hover:bg-[#ede8dc] text-[11px] font-medium text-[#3b4742] transition text-left hover:border-[#beb4a2] shadow-xs"
                  >
                    <Icon className="w-3.5 h-3.5 text-[#556760] flex-shrink-0" />
                    <span className="truncate">{q.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Messages Stream */}
          <div className="flex flex-col-reverse pt-2 gap-6">
            {/* Scroll anchor - first in DOM = bottom visually with flex-col-reverse */}
            <div ref={messagesEndRef} />

            {/* Error Banner with Retry */}
            {errorMessage && (
              <div className="self-center p-3 rounded-xl bg-rose-50 border border-rose-200 text-xs text-rose-800 flex items-center justify-between max-w-2xl">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                  <span>{errorMessage}</span>
                </div>
                <button
                  onClick={() => handleSend(lastFailedMessage || undefined)}
                  className="flex items-center gap-1 font-semibold text-rose-900 hover:underline"
                >
                  <RefreshCw className="w-3 h-3" /> Retry
                </button>
              </div>
            )}

            {/* Pulsing Assistant Typing Loader */}
            {isLoading && (
              <div className="flex items-center gap-3 self-start">
                <div className="w-8 h-8 rounded-full bg-[#1b342e] text-[#f7eedc] flex items-center justify-center">
                  <Bot className="w-4 h-4 animate-spin" />
                </div>
                <div className="bg-[#f6f4ee] border border-[#eae5d8] px-4 py-2.5 rounded-2xl rounded-tl-none text-xs text-[#52615b] flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#24423b] animate-bounce"></span>
                  <span className="w-1.5 h-1.5 rounded-full bg-[#24423b] animate-bounce [animation-delay:0.2s]"></span>
                  <span className="w-1.5 h-1.5 rounded-full bg-[#24423b] animate-bounce [animation-delay:0.4s]"></span>
                  <span className="ml-1 text-[11px]">Assistant is retrieving verified hotel info...</span>
                </div>
              </div>
            )}

            {/* Messages - reversed so latest appears at bottom visually */}
            {messages?.slice().reverse().map((m) => (
              <div key={m.id} className="space-y-3">{m.role === "user" ? (
                  /* User Bubble */
                  <div className="flex justify-end items-end gap-2" data-testid="user-message">
                    <span className="text-[10px] text-[#919c96] mb-1">{m.timestamp}</span>
                    <div className="bg-[#24423b] text-white text-xs px-4 py-3 rounded-2xl rounded-tr-none max-w-md shadow-sm leading-relaxed">
                      {m.content}
                    </div>
                    <div className="w-7 h-7 rounded-full bg-[#3d5a52] text-white flex items-center justify-center flex-shrink-0 text-[11px]">
                      <Users className="w-3.5 h-3.5" />
                    </div>
                  </div>
                ) : (
                  /* Assistant Bubble */
                  <div className="flex items-start gap-3" data-testid={m.id === "welcome-assistant" ? "welcome-message" : "assistant-message"}>
                    <div className="w-8 h-8 rounded-full bg-[#1b342e] text-[#f7eedc] flex items-center justify-center flex-shrink-0 mt-1 shadow-sm">
                      <svg viewBox="0 0 100 100" className="w-4 h-4 fill-none stroke-current stroke-[6]">
                        <path d="M50 20 C40 35 30 55 50 80 C70 55 60 35 50 20 Z" />
                        <path d="M50 80 C30 75 15 50 25 35 C35 38 45 55 50 80 Z" />
                        <path d="M50 80 C70 75 85 50 75 35 C65 38 55 55 50 80 Z" />
                      </svg>
                    </div>

                    <div className="space-y-3 max-w-3xl flex-1">
                      <div className="bg-[#f6f4ee] border border-[#eae5d8] text-[#24332e] text-xs p-4 rounded-2xl rounded-tl-none leading-relaxed shadow-xs">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {m.content}
                        </ReactMarkdown>
                      </div>

                      {/* Room Cards Carousel/Grid when Availability is Returned */}
                      {m.availabilityData?.rooms && m.availabilityData.rooms.length > 0 && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 pt-1">
                          {m.availabilityData.rooms.map((room) => {
                            const bedDesc =
                              typeof room.beds === "string"
                                ? room.beds
                                : Array.isArray(room.beds)
                                ? room.beds.map((b: { type: string; count: number }) => `${b.count} ${b.type}`).join(", ")
                                : "1 king bed";

                            return (
                              <div
                                key={room.id}
                                className="bg-white border border-[#e5dfd2] rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition flex flex-col justify-between group"
                              >
                                <div>
                                  {/* Room Photo */}
                                  <div className="relative h-32 w-full bg-slate-100 overflow-hidden">
                                    <Image
                                      src={room.image || "/Deluxe room.png"}
                                      alt={room.name}
                                      fill
                                      className="object-cover group-hover:scale-105 transition-transform duration-500"
                                    />
                                    {room.badge && (
                                      <span className="absolute top-2.5 left-2.5 bg-[#dbe7e2]/90 backdrop-blur-xs text-[#1e3a34] text-[10px] font-semibold px-2 py-0.5 rounded-md shadow-xs">
                                        {room.badge}
                                      </span>
                                    )}
                                  </div>

                                  {/* Room Details */}
                                  <div className="p-3">
                                    <h4 className="font-bold text-xs text-[#1a2d28] tracking-tight">
                                      {room.name}
                                    </h4>
                                    <p className="text-[11px] text-[#6d7a74] mt-0.5 truncate">
                                      {room.description || "A comfortable and stylish stay"}
                                    </p>

                                    {/* Capacity and Bed Specs */}
                                    <div className="flex items-center gap-3 text-[11px] text-[#55635d] mt-2.5">
                                      <div className="flex items-center gap-1">
                                        <Users className="w-3 h-3 text-[#798881]" />
                                        <span>{room.maxOccupancy} guests</span>
                                      </div>
                                      <div className="flex items-center gap-1">
                                        <BedDouble className="w-3 h-3 text-[#798881]" />
                                        <span>{bedDesc}</span>
                                      </div>
                                    </div>

                                    {/* Price Tag */}
                                    <div className="mt-3 text-xs font-bold text-[#1a2d28]">
                                      {room.currency === "USD" || !room.currency ? "$" : room.currency} {room.pricePerNight}{" "}
                                      <span className="text-[10px] font-normal text-[#75847e]">
                                        / night
                                      </span>
                                    </div>
                                  </div>
                                </div>

                                {/* Select Button */}
                                <div className="p-3 pt-0">
                                  <button
                                    onClick={() =>
                                      handleSend(
                                        `I would like to select the ${room.name} for my stay.`
                                      )
                                    }
                                    className="w-full bg-[#24423b] hover:bg-[#19322c] text-white text-[11px] font-medium py-2 rounded-xl transition"
                                  >
                                    Select Room
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      <span className="text-[10px] text-[#919c96] block">{m.timestamp}</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Input Bar at the Bottom */}
        <footer className="p-4 sm:p-6 pt-2 bg-gradient-to-t from-white via-white to-transparent">
          {/* Inline availability form: rendered on demand above the input bar */}
          {showAvailabilityForm && (
            <AvailabilityForm
              initialAdults={availabilityFormAdults}
              onClose={() => setShowAvailabilityForm(false)}
              onSubmit={handleAvailabilitySearch}
            />
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="max-w-4xl mx-auto flex items-center gap-2 bg-white border border-[#d6cfbe] rounded-2xl px-3 py-1.5 shadow-sm focus-within:border-[#24423b] focus-within:ring-2 focus-within:ring-[#24423b]/10 transition"
          >
            <button
              type="button"
              className="p-2 text-[#7f8e87] hover:text-[#24423b] transition"
              title="Attach document"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type your message here..."
              disabled={isLoading}
              className="flex-1 bg-transparent text-xs text-[#20312b] placeholder-[#8c9a93] outline-none px-2 py-1.5"
            />

            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="w-8 h-8 rounded-xl bg-[#24423b] hover:bg-[#1a332d] text-white flex items-center justify-center transition disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </form>

          <p className="text-[10px] text-center text-[#8e9c95] mt-2">
            Powered by AI. Answers are based on verified hotel information and may not always be complete.
          </p>
        </footer>
      </main>

      {/* ────────────────── RIGHT SIDEBAR ────────────────── */}
      <aside className="w-80 bg-[#fdfbf7] border-l border-[#ece8df] p-5 hidden xl:flex flex-col justify-between flex-shrink-0 overflow-y-auto">
        <div className="space-y-5">
          {/* Top Destination Hero Card */}
          <div className="relative h-44 rounded-2xl overflow-hidden shadow-sm">
            <Image
              src="/Side protion.png"
              alt="Resort Pool"
              fill
              className="object-cover"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent flex flex-col justify-end p-4 text-white">
              <h4 className="font-serif text-base font-bold leading-tight">
                Relax. Explore. Belong.
              </h4>
              <p className="text-[11px] text-[#e3ded4] mt-0.5">
                {hotelData?.property.name ?? "The Grandview Hotel & Resort"}
              </p>
              <div className="flex items-center gap-1 text-[10px] text-[#cfc7b7] mt-1">
                <MapPin className="w-3 h-3" />
                <span>
                  {hotelData
                    ? `${hotelData.property.address.city}, ${hotelData.property.address.state}`
                    : "Goa, India"}
                </span>
              </div>
            </div>
          </div>

          {/* Property Fast Facts Card */}
          <div className="bg-[#f8f6f0] border border-[#eae5d8] rounded-2xl p-4 space-y-3.5">
            {/* Check-In */}
            <div className="flex items-start gap-3">
              <div className="p-1.5 rounded-lg bg-[#ece7da] text-[#2d4941]">
                <Calendar className="w-4 h-4" />
              </div>
              <div>
                <p className="text-[10px] text-[#718079] font-medium">Check-in</p>
                <p className="text-xs font-bold text-[#1c2c27]">
                  {hotelData
                    ? formatTime24to12(hotelData.property.checkInTime)
                    : "3:00 PM"}
                </p>
              </div>
            </div>

            {/* Check-Out */}
            <div className="flex items-start gap-3">
              <div className="p-1.5 rounded-lg bg-[#ece7da] text-[#2d4941]">
                <Calendar className="w-4 h-4" />
              </div>
              <div>
                <p className="text-[10px] text-[#718079] font-medium">Check-out</p>
                <p className="text-xs font-bold text-[#1c2c27]">
                  {hotelData
                    ? formatTime24to12(hotelData.property.checkOutTime)
                    : "11:00 AM"}
                </p>
              </div>
            </div>

            {/* Breakfast */}
            <div className="flex items-start gap-3">
              <div className="p-1.5 rounded-lg bg-[#ece7da] text-[#2d4941]">
                <Coffee className="w-4 h-4" />
              </div>
              <div>
                <p className="text-[10px] text-[#718079] font-medium">Breakfast</p>
                <p className="text-xs font-bold text-[#1c2c27]">
                  {hotelData
                    ? getBreakfastSummary(hotelData)
                    : "Included (select plans)"}
                </p>
              </div>
            </div>

            {/* Wi-Fi */}
            <div className="flex items-start gap-3">
              <div className="p-1.5 rounded-lg bg-[#ece7da] text-[#2d4941]">
                <Wifi className="w-4 h-4" />
              </div>
              <div>
                <p className="text-[10px] text-[#718079] font-medium">Wi-Fi</p>
                <p className="text-xs font-bold text-[#1c2c27]">
                  {hotelData
                    ? getAmenitySummary(hotelData, "wifi")
                    : "Free throughout the property"}
                </p>
              </div>
            </div>

            {/* Swimming Pool */}
            <div className="flex items-start gap-3">
              <div className="p-1.5 rounded-lg bg-[#ece7da] text-[#2d4941]">
                <Waves className="w-4 h-4" />
              </div>
              <div>
                <p className="text-[10px] text-[#718079] font-medium">Swimming Pool</p>
                <p className="text-xs font-bold text-[#1c2c27]">
                  {hotelData
                    ? getAmenitySummary(hotelData, "pool")
                    : "Yes, outdoor pool"}
                </p>
              </div>
            </div>

            {/* Pet Policy */}
            <div className="flex items-start gap-3">
              <div className="p-1.5 rounded-lg bg-[#ece7da] text-[#2d4941]">
                <Ban className="w-4 h-4" />
              </div>
              <div>
                <p className="text-[10px] text-[#718079] font-medium">Pet Policy</p>
                <p className="text-xs font-bold text-[#1c2c27]">
                  {hotelData
                    ? getPolicySummary(hotelData, "pets")
                    : "Not allowed"}
                </p>
              </div>
            </div>
          </div>

          {/* Guest Review Quote Card */}
          <div className="bg-[#f8f6f0] border border-[#eae5d8] rounded-2xl p-4 relative">
            <Quote className="w-5 h-5 text-[#9cb1a9] mb-2" />
            <p className="text-xs font-serif italic text-[#263731] leading-relaxed">
              &ldquo;Beautiful property, amazing staff and a truly relaxing experience.&rdquo;
            </p>
            <p className="text-[10px] font-semibold text-[#6d7c75] mt-2">
              — Recent Guest
            </p>
            <div className="flex items-center justify-center gap-1.5 mt-3">
              <span className="w-1.5 h-1.5 rounded-full bg-[#24423b]"></span>
              <span className="w-1.5 h-1.5 rounded-full bg-[#cbcfcb]"></span>
              <span className="w-1.5 h-1.5 rounded-full bg-[#cbcfcb]"></span>
              <span className="w-1.5 h-1.5 rounded-full bg-[#cbcfcb]"></span>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
