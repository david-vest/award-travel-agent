"use client";

import {
  AirplaneTilt, ArrowsDownUp, ArrowLeft, ArrowRight, ArrowSquareOut, CalendarBlank, CaretDown,
  CaretLeft, CaretRight, Check, CheckCircle, GlobeHemisphereWest, LockKey,
  Funnel, MagnifyingGlass, MapPin, Minus, PaperPlaneTilt, Plus, Sparkle, Star, Trophy, User, X,
  ThumbsDown, ThumbsUp,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AWARD_PROGRAMS, CREDIT_CARD_PROGRAMS, type AwardProgramId, type CreditCardProgramId } from "../src/domain/programs";
import { SUPPORTED_AIRLINES } from "../src/domain/airlines";
import type { ClarificationChoiceId, FlightRecommendation, TripRequest } from "../src/contracts/travel-search";
import {
  RANKING_EXPERIENCE_WEIGHTS,
  RANKING_LEVELS,
  RECOMMENDATION_PIPELINE_VERSION,
  defaultRankingPreference,
  rankingLevelLabel,
  type RankingPreference,
  type RankingPriority,
} from "../src/domain/recommendation-preferences";
import {
  LAST_SEARCH_STORAGE_KEY,
  parseLastSearchSnapshot,
  type LastSearchSnapshot,
  type StoredAgentRun,
  type StoredChatMessage,
  type StoredLocation,
  type StoredSearchForm,
} from "../src/local/last-search";
import { AirlineLogo } from "./AirlineLogo";
import {
  activeFlightFilterCount,
  applyFlightControls,
  buildFlightComparisonRows,
  DEFAULT_FLIGHT_FILTERS,
  FLIGHT_SORT_OPTIONS,
  recommendationDeltas,
  RECOMMENDATION_BADGE_LABELS,
  type FlightResultFilters,
  type FlightSort,
} from "./flight-results";
import { useAgentRun } from "./useAgentRun";
import { formatSchedule } from "../src/ui/flight-times";
import { bookingProgramName, bookingUrlForFlight } from "../src/booking-links";
import styles from "./page.module.css";

type LocationOption = StoredLocation;

type Cabin = "economy" | "premium" | "business" | "first";
type OpenPanel = "origin" | "destinations" | "dates" | "cabins" | "points" | "airlines" | null;
const CLEARED_LAST_SEARCH_STORAGE_KEY = "roam:last-search:cleared:v1";

const researchSteps = [
  { title: "Search live award space", evidence: "Seats.aero availability" },
  { title: "Verify itinerary and experience evidence", evidence: "Flight details + option-linked sources" },
  { title: "Blend value and journey quality", evidence: "Deterministic hybrid rank" },
];

const originInitial: LocationOption = { kind: "airport", code: "SFO", city: "San Francisco", country: "United States", airports: ["SFO"] };
const destinationInitial: LocationOption[] = [
  { kind: "city", code: "TYO", city: "Tokyo", country: "Japan", airports: ["HND", "NRT"] },
  { kind: "city", code: "SEL", city: "Seoul", country: "South Korea", airports: ["ICN", "GMP"] },
];

const cabinOptions: { id: Cabin; name: string; short: string; code: string }[] = [
  { id: "economy", name: "Economy", short: "Econ", code: "Y" },
  { id: "premium", name: "Premium Economy", short: "Premium Econ", code: "W" },
  { id: "business", name: "Business", short: "Biz", code: "J" },
  { id: "first", name: "First", short: "First", code: "F" },
];

const rankingPriorityOptions: Array<{ id: RankingPriority; label: string }> = [
  { id: "cabin_product", label: "Best seat" },
  { id: "schedule", label: "Better schedule" },
  { id: "few_connections", label: "Fewer stops" },
  { id: "connection_quality", label: "Easier connections" },
  { id: "booking_ease", label: "Easier booking" },
  { id: "low_transfer_risk", label: "Lower transfer risk" },
];

export default function Home() {
  const [origin, setOrigin] = useState<LocationOption | null>(originInitial);
  const [destinations, setDestinations] = useState(destinationInitial);
  const [startDate, setStartDate] = useState("2026-09-18");
  const [endDate, setEndDate] = useState("2026-09-27");
  const [flexDays, setFlexDays] = useState(0);
  const [cabins, setCabins] = useState<Cabin[]>(["business"]);
  const [travelers, setTravelers] = useState("1 traveler");
  const [selectedCreditPrograms, setSelectedCreditPrograms] = useState<CreditCardProgramId[]>(["chase", "amex"]);
  const [selectedAwardPrograms, setSelectedAwardPrograms] = useState<AwardProgramId[]>(() => Array.from(new Set(CREDIT_CARD_PROGRAMS.filter((card) => card.id === "chase" || card.id === "amex").flatMap((card) => card.programs))) as AwardProgramId[]);
  const [creditCardBalances, setCreditCardBalances] = useState<Partial<Record<CreditCardProgramId, string>>>({});
  const [awardProgramBalances, setAwardProgramBalances] = useState<Partial<Record<AwardProgramId, string>>>({});
  const [maxFees, setMaxFees] = useState("");
  const [stops, setStops] = useState<"nonstop" | "one" | "any">("one");
  const [preferredAirlines, setPreferredAirlines] = useState<string[]>([]);
  const [rankingPreference, setRankingPreference] = useState<RankingPreference>(defaultRankingPreference);
  const [airlineQuery, setAirlineQuery] = useState("");
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const [notes, setNotes] = useState("");
  const [activeFlight, setActiveFlight] = useState(0);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [flightSort, setFlightSort] = useState<FlightSort>("recommended");
  const [resultFilters, setResultFilters] = useState<FlightResultFilters>(DEFAULT_FLIGHT_FILTERS);
  const railRef = useRef<HTMLDivElement>(null);
  const lastSubmittedFormRef = useRef<StoredSearchForm | null>(null);
  const chatMessageSequenceRef = useRef(0);
  const [followUp, setFollowUp] = useState("");
  const [chatMessages, setChatMessages] = useState<StoredChatMessage[]>([]);
  const [rating, setRating] = useState<"up" | "down" | null>(null);
  const [chosenOptionId, setChosenOptionId] = useState<string | null>(null);
  const agentRun = useAgentRun();
  const restoreAgentRun = agentRun.restore;
  const resetAgentRun = agentRun.reset;
  const allFlights = agentRun.recommendations;
  const flights = useMemo(() => applyFlightControls(allFlights, flightSort, resultFilters), [allFlights, flightSort, resultFilters]);
  const filterCount = activeFlightFilterCount(resultFilters);
  const availableCabins = useMemo(() => [...new Set(allFlights.map((flight) => flight.cabin))], [allFlights]);
  const availablePrograms = useMemo(() => [...new Map(allFlights.map((flight) => [flight.program.id, flight.program])).values()], [allFlights]);
  const comparisonFlights = useMemo(() => compareIds.flatMap((id) => {
    const flight = allFlights.find((candidate) => candidate.id === id);
    return flight ? [flight] : [];
  }), [allFlights, compareIds]);
  const running = agentRun.status === "running";
  const canSearch = origin !== null && destinations.length > 0 && Boolean(startDate && endDate) && cabins.length > 0;
  const analysisPending = running && !agentRun.answer;
  const activeFlightIndex = Math.min(activeFlight, Math.max(0, flights.length - 1));
  const travelerCount = travelerCountFromLabel(travelers);
  const filteredAirlines = useMemo(() => {
    const query = airlineQuery.trim().toLowerCase();
    return query ? SUPPORTED_AIRLINES.filter((airline) => airline.name.toLowerCase().includes(query) || airline.code.toLowerCase().includes(query)) : SUPPORTED_AIRLINES;
  }, [airlineQuery]);

  const resetSearchForm = useCallback(() => {
    setOrigin(null);
    setDestinations([]);
    setStartDate("");
    setEndDate("");
    setFlexDays(0);
    setCabins([]);
    setTravelers("1 traveler");
    setSelectedCreditPrograms([]);
    setSelectedAwardPrograms([]);
    setCreditCardBalances({});
    setAwardProgramBalances({});
    setMaxFees("");
    setStops("one");
    setPreferredAirlines([]);
    setRankingPreference(defaultRankingPreference());
    setAirlineQuery("");
    setNotes("");
    setOpenPanel(null);
    setActiveFlight(0);
    setBookingOpen(false);
    setFiltersOpen(false);
    setComparisonOpen(false);
    setCompareIds([]);
    setFlightSort("recommended");
    setResultFilters(DEFAULT_FLIGHT_FILTERS);
    setFollowUp("");
    setChatMessages([]);
  }, []);

  useEffect(() => {
    if (hasClearedLastSearch()) {
      const timer = window.setTimeout(() => {
        resetSearchForm();
        resetAgentRun();
      }, 0);
      return () => window.clearTimeout(timer);
    }

    const snapshot = readLastSearch();
    if (!snapshot) return;

    const timer = window.setTimeout(() => {
      const form = snapshot.form;
      lastSubmittedFormRef.current = form;
      setOrigin(form.origin);
      setDestinations(form.destinations);
      setStartDate(form.startDate);
      setEndDate(form.endDate);
      setFlexDays(form.flexDays);
      setCabins(form.cabins);
      setTravelers(form.travelers);
      setSelectedCreditPrograms(form.selectedCreditPrograms.filter(isCreditCardProgramId));
      setSelectedAwardPrograms(form.selectedAwardPrograms.filter(isAwardProgramId));
      setCreditCardBalances(form.creditCardBalances as Partial<Record<CreditCardProgramId, string>>);
      setAwardProgramBalances(form.awardProgramBalances as Partial<Record<AwardProgramId, string>>);
      setMaxFees(form.maxFees);
      setStops(form.stops);
      setPreferredAirlines(form.preferredAirlines);
      setRankingPreference(form.rankingPreference);
      setNotes(form.notes);
      setChatMessages(snapshot.chatMessages);
      if (snapshot.run) restoreAgentRun(snapshot.run);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [resetAgentRun, resetSearchForm, restoreAgentRun]);

  useEffect(() => {
    if (
      (agentRun.status !== "clarification" && agentRun.status !== "complete" && agentRun.status !== "error") ||
      !lastSubmittedFormRef.current
    ) return;
    const run: StoredAgentRun = {
      status: agentRun.status,
      stages: agentRun.stages,
      stageDetails: agentRun.stageDetails,
      stageDurations: agentRun.stageDurations,
      recommendations: agentRun.recommendations,
      answer: agentRun.answer,
      error: agentRun.error,
      threadId: agentRun.threadId,
      runId: agentRun.runId,
      clarification: agentRun.clarification,
    };
    writeLastSearch({ version: 1, savedAt: new Date().toISOString(), form: lastSubmittedFormRef.current, run, chatMessages });
  }, [agentRun.answer, agentRun.clarification, agentRun.error, agentRun.recommendations, agentRun.runId, agentRun.stageDetails, agentRun.stageDurations, agentRun.stages, agentRun.status, agentRun.threadId, chatMessages]);

  const changeResultFilters = (next: FlightResultFilters) => {
    setResultFilters(next);
    setActiveFlight(0);
    railRef.current?.scrollTo({ left: 0 });
  };

  const runSearch = () => {
    if (running || !origin || !destinations.length || !startDate || !endDate || !cabins.length) return;
    const form: StoredSearchForm = {
      origin,
      destinations,
      startDate,
      endDate,
      flexDays,
      cabins,
      travelers,
      selectedCreditPrograms,
      selectedAwardPrograms,
      creditCardBalances,
      awardProgramBalances,
      maxFees,
      stops,
      preferredAirlines,
      rankingPreference,
      notes,
    };
    lastSubmittedFormRef.current = form;
    setChatMessages([]);
    setCompareIds([]);
    setComparisonOpen(false);
    setRating(null);
    setChosenOptionId(null);
    writeLastSearch({ version: 1, savedAt: new Date().toISOString(), form, run: null, chatMessages: [] });
    const request: TripRequest = {
      origin: { code: origin.code, airports: origin.airports, custom: origin.kind === "custom" },
      destinations: destinations.map((destination) => ({ code: destination.code, airports: destination.airports, custom: destination.kind === "custom" })),
      startDate,
      endDate,
      flexDays,
      cabins,
      travelers: Number.parseInt(travelers, 10) || 1,
      stopPreference: stops === "one" ? "up_to_one" : stops,
      preferredAirlines,
      rankingPreference,
      creditCardPrograms: selectedCreditPrograms,
      awardPrograms: selectedAwardPrograms,
      pointBalances: {
        creditCards: numericBalanceRecord(creditCardBalances),
        awardPrograms: numericBalanceRecord(awardProgramBalances),
      },
      maxTaxesFeesUsd: optionalNumber(maxFees),
      notes: notes || undefined,
    };
    setOpenPanel(null); setActiveFlight(0);
    railRef.current?.scrollTo({ left: 0, behavior: "smooth" });
    void agentRun.start({ request });
  };

  const sendFollowUp = () => {
    const message = followUp.trim();
    if (!message || running || agentRun.status === "clarification") return;

    const nextMessageId = (role: StoredChatMessage["role"]) => {
      chatMessageSequenceRef.current += 1;
      return `${role}-${Date.now()}-${chatMessageSequenceRef.current}`;
    };
    const previousAnswer = agentRun.answer.trim();
    setChatMessages((current) => [
      ...current,
      ...(previousAnswer ? [{ id: nextMessageId("assistant"), role: "assistant" as const, content: previousAnswer }] : []),
      { id: nextMessageId("user"), role: "user", content: message },
    ]);
    setFollowUp("");
    setRating(null);
    void agentRun.start({ message });
  };

  const resolveClarification = (choiceId: ClarificationChoiceId) => {
    if (choiceId === "allow_one_stop") {
      setStops("one");
      if (lastSubmittedFormRef.current) lastSubmittedFormRef.current.stops = "one";
    } else if (choiceId === "try_premium_economy") {
      setCabins(["premium"]);
      if (lastSubmittedFormRef.current) lastSubmittedFormRef.current.cabins = ["premium"];
    }
    void agentRun.resumeClarification(choiceId);
  };

  const feedbackContext = () => ({
    rankingVersion: RECOMMENDATION_PIPELINE_VERSION,
    preferenceProfile: rankingPreference,
    candidateIds: allFlights.map((flight) => flight.id),
    evidenceIds: [...new Set(allFlights.flatMap((flight) => flight.evidenceIds ?? []))],
  });

  const rateRecommendations = (nextRating: "up" | "down") => {
    setRating(nextRating);
    void agentRun.submitFeedback({ kind: "rating", rating: nextRating, ...feedbackContext() });
  };

  const chooseRecommendation = (optionId: string) => {
    setChosenOptionId(optionId);
    void agentRun.submitFeedback({
      kind: "selected_option",
      selectedOptionId: optionId,
      ...feedbackContext(),
    });
  };

  const clearSearch = () => {
    resetAgentRun();
    lastSubmittedFormRef.current = null;
    resetSearchForm();
    clearLastSearch();
  };

  const moveCarousel = (nextIndex: number) => {
    const bounded = Math.max(0, Math.min(Math.max(flights.length - 1, 0), nextIndex));
    setActiveFlight(bounded);
    const rail = railRef.current;
    const card = rail?.children[bounded] as HTMLElement | undefined;
    if (rail && card) rail.scrollTo({ left: card.offsetLeft - rail.offsetLeft, behavior: "smooth" });
  };

  const syncCarousel = () => {
    const rail = railRef.current;
    if (!rail) return;
    const cards = Array.from(rail.children) as HTMLElement[];
    const closest = cards.reduce((best, card, index) => {
      const distance = Math.abs(card.offsetLeft - rail.offsetLeft - rail.scrollLeft);
      return distance < best.distance ? { index, distance } : best;
    }, { index: 0, distance: Number.POSITIVE_INFINITY });
    setActiveFlight(closest.index);
  };

  const toggleCreditProgram = (id: CreditCardProgramId) => {
    const selected = selectedCreditPrograms.includes(id);
    const card = CREDIT_CARD_PROGRAMS.find((item) => item.id === id);
    if (!card) return;
    const nextCards = selected ? selectedCreditPrograms.filter((item) => item !== id) : [...selectedCreditPrograms, id];
    setSelectedCreditPrograms(nextCards);
    setSelectedAwardPrograms((current) => {
      if (!selected) return Array.from(new Set([...current, ...card.programs])) as AwardProgramId[];
      const supportedByRemainingCards = new Set(CREDIT_CARD_PROGRAMS.filter((item) => nextCards.includes(item.id)).flatMap((item) => item.programs));
      return current.filter((program) => !card.programs.includes(program) || supportedByRemainingCards.has(program));
    });
  };

  const toggleAwardProgram = (id: AwardProgramId) => {
    setSelectedAwardPrograms((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const pointsLabel = selectedCreditPrograms.length
    ? `${selectedCreditPrograms.map((id) => CREDIT_CARD_PROGRAMS.find((card) => card.id === id)?.name).join(" + ")} · ${selectedAwardPrograms.length} programs${hasEnteredBalances(creditCardBalances, awardProgramBalances) ? " · balances set" : ""}`
    : selectedAwardPrograms.length ? `${selectedAwardPrograms.length} award programs` : "Choose programs";

  return (
    <div className={styles.page} onClick={(event) => {
      if (event.target instanceof Element && event.target.closest("[data-popover]")) return;
      setOpenPanel(null);
    }}>
      <header className={styles.header}>
        <a className={styles.brand} href="#search">Roam</a>
        <nav className={styles.nav} aria-label="Primary navigation"><a className={styles.navActive} href="#search">Search</a></nav>
      </header>

      <main className={styles.workspace}>
        <section id="search" className={styles.searchPanel} aria-labelledby="search-heading">
          <div className={styles.panelIntro}><h1 id="search-heading">Where should Roam take you?</h1><p>Set the boundaries. Roam will research the best way to book.</p></div>
          <div className={styles.fields}>
            <AirportPicker title="From" icon={<MapPin size={23} />} value={origin ? [origin] : []} multiple={false} open={openPanel === "origin"} onToggle={() => setOpenPanel(openPanel === "origin" ? null : "origin")} onChange={(value) => { setOrigin(value[0] ?? null); setOpenPanel(null); }} />
            <AirportPicker title="Possible destinations" icon={<GlobeHemisphereWest size={23} />} value={destinations} multiple open={openPanel === "destinations"} onToggle={() => setOpenPanel(openPanel === "destinations" ? null : "destinations")} onChange={setDestinations} />
            <DatePicker start={startDate} end={endDate} flexDays={flexDays} open={openPanel === "dates"} onToggle={() => setOpenPanel(openPanel === "dates" ? null : "dates")} onDatesChange={(start, end) => { setStartDate(start); setEndDate(end); }} onFlexChange={setFlexDays} />
            <CabinPicker selected={cabins} open={openPanel === "cabins"} onToggle={() => setOpenPanel(openPanel === "cabins" ? null : "cabins")} onChange={setCabins} />
            <TravelerStepper count={travelerCount} onChange={(count) => setTravelers(travelerLabel(count))} />
            <PointsPicker value={pointsLabel} selectedCards={selectedCreditPrograms} selectedPrograms={selectedAwardPrograms} cardBalances={creditCardBalances} programBalances={awardProgramBalances} open={openPanel === "points"} onToggle={() => setOpenPanel(openPanel === "points" ? null : "points")} onToggleCard={toggleCreditProgram} onToggleProgram={toggleAwardProgram} onCardBalance={(id, value) => setCreditCardBalances((current) => ({ ...current, [id]: digitsOnly(value) }))} onProgramBalance={(id, value) => setAwardProgramBalances((current) => ({ ...current, [id]: digitsOnly(value) }))} onClear={() => { setSelectedCreditPrograms([]); setSelectedAwardPrograms([]); setCreditCardBalances({}); setAwardProgramBalances({}); }} />
          </div>

          <div className={styles.filterSection}>
            <div className={styles.filterHeading}><span>Search preferences</span><small>Roam can still surface an exceptional outlier.</small></div>
            <div className={styles.filterRow}>
              <div className={styles.stopPicker} aria-label="Stops preference">
                {([['nonstop', 'Nonstop'], ['one', '≤ 1 stop'], ['any', 'Any stops']] as const).map(([id, label]) => <button key={id} className={stops === id ? styles.filterActive : ""} onClick={() => setStops(id)}>{label}</button>)}
              </div>
              <div className={styles.airlineFilterWrap} data-popover>
                <button className={styles.airlineFilterButton} aria-expanded={openPanel === "airlines"} onClick={() => setOpenPanel(openPanel === "airlines" ? null : "airlines")}>{preferredAirlines.length ? `${preferredAirlines.length} airline${preferredAirlines.length > 1 ? "s" : ""}` : "Any airline"}<CaretDown size={13} weight="bold" /></button>
                {openPanel === "airlines" && <div className={styles.airlineMenu}>
                  <div className={styles.airlineMenuHeader}><label className={styles.airlineSearch}><MagnifyingGlass size={14} /><input autoFocus value={airlineQuery} onChange={(event) => setAirlineQuery(event.target.value)} placeholder="Filter airlines" /></label>{preferredAirlines.length > 0 && <button className={styles.clearAirlines} onClick={() => { setPreferredAirlines([]); setAirlineQuery(""); }}>Clear</button>}</div>
                  <div className={styles.airlineList}>{filteredAirlines.map((airline) => {
                  const selected = preferredAirlines.includes(airline.code);
                  return <button key={airline.code} className={selected ? styles.selectedOption : ""} onClick={() => setPreferredAirlines((current) => selected ? current.filter((code) => code !== airline.code) : [...current, airline.code])}><AirlineLogo code={airline.code} name={airline.name} size={25} /><span>{airline.name}</span><small>{airline.code}</small><Check size={14} weight="bold" /></button>;
                })}</div></div>}
              </div>
              <label className={styles.limitField}><span>Max taxes &amp; fees</span><div><b>$</b><input inputMode="decimal" value={maxFees} onChange={(event) => setMaxFees(decimalOnly(event.target.value))} placeholder="Any" aria-label="Maximum taxes and fees per traveler in USD" /><small>USD / traveler</small></div></label>
            </div>
            <div className={styles.rankingPreference}>
              <div className={styles.rankingPreferenceHeading}>
                <label htmlFor="ranking-experience">How should Roam rank the options?</label>
                <output htmlFor="ranking-experience">{rankingLevelLabel(rankingPreference.experienceWeight)}</output>
              </div>
              <input
                id="ranking-experience"
                className={styles.rankingSlider}
                type="range"
                min={RANKING_EXPERIENCE_WEIGHTS[0]}
                max={RANKING_EXPERIENCE_WEIGHTS[RANKING_EXPERIENCE_WEIGHTS.length - 1]}
                step={25}
                value={rankingPreference.experienceWeight}
                aria-valuetext={rankingLevelLabel(rankingPreference.experienceWeight)}
                onChange={(event) => setRankingPreference((current) => ({
                  ...current,
                  experienceWeight: Number(event.target.value),
                }))}
              />
              <div className={styles.rankingScale} aria-hidden="true">
                {RANKING_LEVELS.map((level) => <span key={level.value}>{level.label}</span>)}
              </div>
              <div className={styles.rankingPriorityPicker} role="group" aria-label="Optional ranking priorities">
                <span>What matters most?</span>
                <div>
                  {rankingPriorityOptions.map((option) => {
                    const selected = rankingPreference.priorities.includes(option.id);
                    return <button
                      type="button"
                      key={option.id}
                      aria-pressed={selected}
                      className={selected ? styles.rankingPriorityActive : ""}
                      onClick={() => setRankingPreference((current) => ({
                        ...current,
                        priorities: selected
                          ? current.priorities.filter((priority) => priority !== option.id)
                          : [...current.priorities, option.id],
                      }))}
                    >{option.label}</button>;
                  })}
                </div>
              </div>
              <p>Cabin, dates, travelers, balances, fee ceilings, and a nonstop selection remain firm constraints.</p>
            </div>
          </div>

          <label className={styles.textLabel}><span>Anything else Roam should know?</span><div className={styles.notesInput}><input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="e.g., avoid early departures, prefer Citi transfer options…" /><PaperPlaneTilt size={20} /></div></label>
          <div className={styles.searchActions}><button className={styles.clearSearchButton} onClick={clearSearch}>Clear all</button><button className={styles.planButton} onClick={runSearch} disabled={running || !canSearch}>{running ? "Planning your trip" : "Plan my trip"}{running ? <Sparkle size={20} weight="fill" /> : <ArrowRight size={20} weight="bold" />}</button></div>
          <p className={styles.privacyNote}><LockKey size={14} /> Roam searches live award space and program rules in real time.</p>
        </section>

        <section className={styles.researchPanel} aria-labelledby="research-heading">
          <div className={styles.researchHeader}>
            <div><h2 id="research-heading">Roam&apos;s research</h2><p>I&apos;m working across live award space and program rules to find the best value for you.</p></div>
            <div className={styles.timestamp}><span>{agentRun.threadId ? `Thread ${agentRun.threadId.slice(0, 8)}` : "Ready to search"}</span><strong><i />{running ? "In progress" : agentRun.status === "clarification" ? "Waiting for you" : agentRun.status === "error" ? "Needs attention" : agentRun.status === "complete" ? "Complete" : "Ready"}</strong></div>
          </div>

          <div className={styles.researchFlow}>
            {researchSteps.map((step, index) => {
              const stage = (["search", "rules", "rank"] as const)[index];
              const complete = agentRun.stages[stage] === "complete"; const active = agentRun.stages[stage] === "active";
              return <article className={`${styles.researchStep} ${complete ? styles.stepComplete : ""} ${active ? styles.stepActive : ""}`} key={step.title}>
                <div className={styles.stepNumber}>{complete ? <Check size={16} weight="bold" /> : index + 1}</div>
                <div className={styles.stepCard}>
                  <div className={styles.stepTitle}>{index === 0 ? <CheckCircle size={21} /> : index === 1 ? <Sparkle size={21} weight={active ? "fill" : "regular"} /> : <Trophy size={21} />}<strong>{step.title}</strong></div>
                  <p>{agentRun.stageDetails[stage]}</p>
                  <span>{complete && agentRun.stageDurations[stage] != null ? `${step.evidence} · ${formatElapsed(agentRun.stageDurations[stage])}` : step.evidence}</span>{active && <div className={styles.liveProgress}><i /><i /><i /><i /><i /><i /><i /></div>}
                </div>
              </article>;
            })}
          </div>

          <section className={`${styles.results} ${running ? styles.resultsWorking : ""}`} aria-labelledby="results-heading">
            <div className={styles.resultsHeader}><div><h3 id="results-heading">Recommended flights</h3><p>{allFlights.length ? `${flights.length.toLocaleString()} of ${allFlights.length.toLocaleString()} options${filtersOpen || filterCount ? " shown" : ""}` : running ? "Searching live award space" : agentRun.status === "clarification" ? "One search constraint needs your decision" : agentRun.status === "complete" ? "No matching options for this exact brief" : "Submit a trip brief to see verified options"}</p></div><div className={styles.carouselControls}><button onClick={() => moveCarousel(activeFlightIndex - 1)} disabled={activeFlightIndex === 0 || flights.length === 0} aria-label="Previous flight"><ArrowLeft size={18} /></button><button onClick={() => moveCarousel(activeFlightIndex + 1)} disabled={activeFlightIndex === flights.length - 1 || flights.length === 0} aria-label="Next flight"><ArrowRight size={18} /></button></div></div>
            {allFlights.length > 0 && <div className={styles.resultsToolbar}>
              <label className={styles.sortControl}><ArrowsDownUp size={15} /><span>Sort</span><select value={flightSort} onChange={(event) => { setFlightSort(event.target.value as FlightSort); setActiveFlight(0); railRef.current?.scrollTo({ left: 0 }); }}>{FLIGHT_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><CaretDown size={12} weight="bold" /></label>
              <button className={filterCount ? styles.filtersActive : ""} onClick={() => setFiltersOpen(true)}><Funnel size={15} weight={filterCount ? "fill" : "regular"} />Filters{filterCount > 0 && <span>{filterCount}</span>}</button>
              <button disabled={comparisonFlights.length < 2} onClick={() => setComparisonOpen(true)} aria-label={`Compare selected flights, ${comparisonFlights.length} selected`}><ArrowsDownUp size={15} />Compare{comparisonFlights.length > 0 && <span>{comparisonFlights.length}</span>}</button>
              {(filterCount > 0 || flightSort !== "recommended") && <button className={styles.clearResultsControls} onClick={() => { changeResultFilters(DEFAULT_FLIGHT_FILTERS); setFlightSort("recommended"); }}>Reset</button>}
            </div>}
            <div className={styles.flightRail} ref={railRef} onScroll={syncCarousel} tabIndex={0} aria-label="All verified flight options">
              {flights.map((flight, index) => {
                const selectedForComparison = compareIds.includes(flight.id);
                const deltas = recommendationDeltas(flight);
                return <article className={`${styles.flightCard} ${flight.rank === 1 ? styles.roamPick : ""} ${index === activeFlightIndex ? styles.activeCard : ""}`} key={`${flight.id}-${flight.cabin}`} onClick={() => moveCarousel(index)}>
                <div className={styles.cardBadges}>{(flight.badges ?? []).map((badge) => <span className={badge === "best_overall" ? styles.primaryBadge : ""} key={badge}>{badge === "best_overall" && <Star size={11} weight="fill" />}{RECOMMENDATION_BADGE_LABELS[badge]}</span>)}</div>
                <div className={styles.flightTitle}>
                  <div className={styles.airlineIdentity}><AirlineLogo code={flight.carriers[0] ?? "?"} name={flight.carriers[0] ?? "Airline"} size={38} /><div><h4>{flight.carriers[0] ?? "Award flight"} {formatCabin(flight.cabin)}</h4><strong>{flight.origin} → {flight.destination}</strong></div></div>
                  <div className={styles.price}><strong>{flight.miles.toLocaleString()} points {flight.taxes ? `+ ${formatTaxes(flight.taxes.amount, flight.taxes.currency)}` : ""}</strong><span>via {flight.program.label}</span></div>
                </div>
                {flight.positioning && <div className={styles.positioningNotice}><strong>Positioning option</strong><span>{[flight.positioning.before, flight.positioning.after].filter(Boolean).join(" · ")}</span><small>{flight.positioning.explanation}</small></div>}
                <p className={styles.flightNumbers}>{flight.flightNumbers.length ? flight.flightNumbers.join(" · ") : "Flight details pending"}</p>
                <div className={styles.flightDetails}>
                  <div><small>Date</small><strong>{formatAgentDate(flight.date)}</strong></div>
                  <div><small>Time</small><strong>{formatSchedule(flight.departsAt, flight.arrivesAt)}</strong></div>
                  <div><small>Duration</small><strong>{formatItineraryDuration(flight)}</strong></div>
                  <div><small>Stops</small><strong>{flight.direct ? "Nonstop" : flight.stops != null ? `${flight.stops} stop${flight.stops === 1 ? "" : "s"}` : "Connection"}</strong></div>
                </div>
                <div className={styles.schedule}>{travelers} · {flight.remainingSeats ? `${flight.remainingSeats} seats available` : "Seat count to confirm"}{flight.connections?.length ? <span className={styles.connectionInfo}>Connect in {formatConnections(flight.connections)}</span> : null}</div>
                {deltas.length > 0 && <div className={styles.tradeoffDeltas} aria-label="Compared with the lowest-cost eligible option">{deltas.map((delta) => <span key={delta}>{delta}</span>)}</div>}
                <div className={styles.reason}><strong>Decision tradeoff</strong><p>{flight.reason}</p>{flight.assessmentConfidence === "low" && !(flight.evidenceIds?.length) && <small>Experience evidence unavailable; journey score uses objective flight facts.</small>}</div>
                <div className={styles.cardActions}>
                  <button className={styles.compareToggle} aria-pressed={selectedForComparison} disabled={!selectedForComparison && compareIds.length >= 3} onClick={(event) => { event.stopPropagation(); setCompareIds((current) => selectedForComparison ? current.filter((id) => id !== flight.id) : [...current, flight.id].slice(0, 3)); }}>{selectedForComparison ? <Check size={15} weight="bold" /> : <Plus size={15} />} {selectedForComparison ? "Selected" : "Compare"}</button>
                  <button className={styles.chooseButton} aria-pressed={chosenOptionId === flight.id} onClick={(event) => { event.stopPropagation(); chooseRecommendation(flight.id); }}>{chosenOptionId === flight.id ? <Check size={15} weight="bold" /> : null}{chosenOptionId === flight.id ? "My choice" : "I’d choose this"}</button>
                  <button className={styles.reviewButton} onClick={(event) => { event.stopPropagation(); setActiveFlight(index); setBookingOpen(true); }}>Review itinerary <ArrowRight size={18} weight="bold" /></button>
                </div>
              </article>;})}
              {!flights.length && <div className={styles.emptyResults}>{agentRun.error ? agentRun.error : running ? "Roam is checking live award availability…" : agentRun.status === "clarification" ? "Choose how Roam should relax the search below." : allFlights.length ? "No flights match these result filters. Clear or widen a filter to see more options." : "Your ranked, grounded recommendations will appear here."}</div>}
            </div>
            {flights.length > 0 && <><div className={styles.scrollTrack}><span style={{ width: `${100 / flights.length}%`, transform: `translateX(${activeFlightIndex * 100}%)` }} /></div><p className={styles.scrollHint}>Scroll through verified options · select 2–3 to compare side by side.</p></>}
            {(chatMessages.length > 0 || analysisPending || agentRun.answer || agentRun.clarification) && <div className={styles.chatThread} aria-label="Follow-up conversation">
              {chatMessages.map((message) => message.role === "user"
                ? <div className={styles.userMessage} key={message.id}><div className={styles.userMessageLabel}>You</div><p>{message.content}</p></div>
                : <div className={styles.agentAnswer} key={message.id}><div className={styles.agentAnswerLabel}><Sparkle size={15} weight="fill" /> Roam</div><ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown></div>)}
              {analysisPending && <div className={`${styles.agentAnswer} ${styles.agentAnswerPending}`} role="status" aria-live="polite"><div className={styles.agentAnswerLabel}><span className={styles.analysisSpinner} aria-hidden="true" /> Roam&apos;s analysis</div><p>{allFlights.length ? "The recommended flights are ready. Roam is finishing the comparison and booking analysis…" : "Roam is preparing the flight analysis…"}</p></div>}
              {agentRun.clarification && <div className={styles.clarificationCard} role="group" aria-labelledby="clarification-prompt">
                <div className={styles.agentAnswerLabel}><Sparkle size={15} weight="fill" /> One decision needed</div>
                <strong id="clarification-prompt">{agentRun.clarification.prompt}</strong>
                <div className={styles.clarificationChoices}>{agentRun.clarification.choices.map((choice) => <button key={choice.id} disabled={running} onClick={() => resolveClarification(choice.id)}><span>{choice.label}</span><small>{choice.description}</small></button>)}</div>
              </div>}
              {agentRun.answer && <div className={styles.agentAnswer}><div className={styles.agentAnswerLabel}><Sparkle size={15} weight="fill" /> Roam&apos;s analysis</div><ReactMarkdown remarkPlugins={[remarkGfm]}>{agentRun.answer}</ReactMarkdown>{agentRun.status === "complete" && <div className={styles.answerFeedback}><span>Was this recommendation useful?</span><button aria-label="Useful recommendation" aria-pressed={rating === "up"} onClick={() => rateRecommendations("up")}><ThumbsUp size={15} weight={rating === "up" ? "fill" : "regular"} /></button><button aria-label="Not useful recommendation" aria-pressed={rating === "down"} onClick={() => rateRecommendations("down")}><ThumbsDown size={15} weight={rating === "down" ? "fill" : "regular"} /></button><small aria-live="polite">{agentRun.feedbackStatus === "saved" ? "Saved" : agentRun.feedbackStatus === "error" ? "Couldn’t save" : ""}</small></div>}</div>}
            </div>}
            <div className={styles.followUp}><input value={followUp} disabled={agentRun.status === "clarification"} onChange={(event) => setFollowUp(event.target.value)} placeholder={agentRun.status === "clarification" ? "Choose an option above to continue" : "Ask Roam a follow-up…"} onKeyDown={(event) => { if (event.key === "Enter") sendFollowUp(); }} /><button aria-label="Send follow-up" disabled={!followUp.trim() || running || agentRun.status === "clarification"} onClick={sendFollowUp}><PaperPlaneTilt size={16} /></button></div>
          </section>
        </section>
      </main>

      {bookingOpen && flights[activeFlightIndex] && <BookingModal flight={flights[activeFlightIndex]} travelers={travelerCount} onClose={() => setBookingOpen(false)} />}
      {filtersOpen && <FlightFiltersModal filters={resultFilters} availableCabins={availableCabins} availablePrograms={availablePrograms} resultCount={flights.length} onChange={changeResultFilters} onClose={() => setFiltersOpen(false)} />}
      {comparisonOpen && comparisonFlights.length >= 2 && <FlightComparisonModal flights={comparisonFlights} onClose={() => setComparisonOpen(false)} />}
    </div>
  );
}

function FieldButton({ icon, title, value, badge, open, onClick }: { icon: React.ReactNode; title: string; value: string; badge?: string; open: boolean; onClick: () => void }) {
  return <button className={styles.searchField} aria-expanded={open} onClick={onClick}><span className={styles.fieldIcon}>{icon}</span><span className={styles.fieldCopy}><small>{title}</small><strong>{value}</strong></span>{badge && <span className={styles.fieldBadge}>{badge}</span>}<CaretDown size={15} weight="bold" /></button>;
}

function AirportPicker({ title, icon, value, multiple, open, onToggle, onChange }: { title: string; icon: React.ReactNode; value: LocationOption[]; multiple: boolean; open: boolean; onToggle: () => void; onChange: (value: LocationOption[]) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LocationOption[]>([]);
  const [resultQuery, setResultQuery] = useState("");

  useEffect(() => {
    if (!open || !query.trim()) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/airports?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (response.ok) {
          setResults(await response.json() as LocationOption[]);
          setResultQuery(query);
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setResults([]);
          setResultQuery(query);
        }
      }
    }, 140);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query]);

  const display = multiple
    ? value.length ? value.map((item) => item.city).join(" + ") : "Add destinations"
    : !value[0] ? "Choose an origin" : value[0].kind === "custom" ? value[0].city : `${value[0].code} · ${value[0].city}`;
  const select = (option: LocationOption) => {
    if (!multiple) { onChange([option]); setQuery(""); return; }
    const selected = value.some((item) => item.code === option.code);
    const next = selected ? value.filter((item) => item.code !== option.code) : [...value, option];
    onChange(next);
  };
  const remove = (option: LocationOption) => {
    if (!multiple) { onChange([]); return; }
    onChange(value.filter((item) => item.code !== option.code));
  };

  return <div className={styles.fieldWrap} data-popover><FieldButton icon={icon} title={title} value={display} open={open} onClick={onToggle} />{open && <div className={`${styles.fieldMenu} ${styles.airportMenu}`}>
    {value.length > 0 && <div className={styles.selectedLocations}>{value.map((item) => <button key={item.code} onClick={() => remove(item)}>{item.city}<X size={12} /></button>)}</div>}
    <label className={styles.searchBox}><MagnifyingGlass size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && query.trim()) { event.preventDefault(); select({ kind: "custom", code: query.trim(), city: query.trim(), country: "Roam will choose the airport", airports: [] }); } }} placeholder={multiple ? "Search a city, place, or airport to add" : "Search city, place, airport, or code"} /></label>
    <div className={styles.locationResults}>
      {!query && <p className={styles.menuPrompt}>Try “Tokyo”, “Europe”, “EUR”, or “JFK”.</p>}
      {query && resultQuery !== query && <p className={styles.menuPrompt}>Searching airports…</p>}
      {resultQuery === query && results.map((option) => {
        const selected = value.some((item) => item.code === option.code);
        return <button key={`${option.kind}-${option.code}`} className={selected ? styles.selectedOption : ""} onClick={() => select(option)}><span className={styles.iataBadge}>{option.code}</span><span className={styles.locationCopy}><strong>{option.city}</strong><small>{option.kind === "city" ? `${option.airports.join(", ")} · ${option.country}` : option.country}</small></span>{option.kind === "city" && <span className={styles.cityTag}>All airports</span>}{option.kind === "group" && <span className={styles.cityTag}>Multi-city</span>}<Check size={14} weight="bold" /></button>;
      })}
      {query && resultQuery === query && <button className={styles.customLocation} onClick={() => { select({ kind: "custom", code: query.trim(), city: query.trim(), country: "Roam will choose the airport", airports: [] }); setQuery(""); }}><span className={styles.customLocationIcon}><Sparkle size={15} weight="fill" /></span><span className={styles.locationCopy}><strong>Search near “{query.trim()}”</strong><small>Roam will select and verify the best commercial airport</small></span><span className={styles.cityTag}>Let Roam decide</span><ArrowRight size={14} /></button>}
    </div>
  </div>}</div>;
}

function DatePicker({ start, end, flexDays, open, onToggle, onDatesChange, onFlexChange }: { start: string; end: string; flexDays: number; open: boolean; onToggle: () => void; onDatesChange: (start: string, end: string) => void; onFlexChange: (days: number) => void }) {
  const [month, setMonth] = useState(() => new Date(2026, 8, 1));
  const days = useMemo(() => calendarDays(month), [month]);
  const startValue = start ? parseDate(start) : null; const endValue = end ? parseDate(end) : null;
  const selectDay = (day: Date) => {
    if (day < todayAtMidnight()) return;
    if (!start || end || !startValue || day < startValue) onDatesChange(toDateKey(day), "");
    else onDatesChange(start, toDateKey(day));
  };

  return <div className={styles.fieldWrap} data-popover><FieldButton icon={<CalendarBlank size={23} />} title="Travel window" value={formatDateRange(start, end)} badge={flexDays ? `± ${flexDays} days` : "Exact"} open={open} onClick={onToggle} />{open && <div className={`${styles.fieldMenu} ${styles.calendarMenu}`}>
    <div className={styles.calendarHeader}><button aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><CaretLeft size={16} /></button><strong>{month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</strong><button aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><CaretRight size={16} /></button></div>
    <div className={styles.weekdays}>{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
    <div className={styles.calendarGrid}>{days.map((day) => {
      const key = toDateKey(day); const outside = day.getMonth() !== month.getMonth();
      const disabled = day < todayAtMidnight(); const selected = key === start || key === end;
      const inRange = Boolean(endValue && startValue && day > startValue && day < endValue);
      return <button key={key} disabled={disabled} className={`${outside ? styles.outsideMonth : ""} ${selected ? styles.selectedDay : ""} ${inRange ? styles.inRange : ""}`} onClick={() => selectDay(day)}>{day.getDate()}</button>;
    })}</div>
    <div className={styles.flexPicker}><span>Flexible dates</span><div>{[0, 1, 2, 3, 7].map((days) => <button key={days} className={flexDays === days ? styles.filterActive : ""} onClick={() => onFlexChange(days)}>{days ? `±${days}` : "Exact"}</button>)}</div></div>
  </div>}</div>;
}

function CabinPicker({ selected, open, onToggle, onChange }: { selected: Cabin[]; open: boolean; onToggle: () => void; onChange: (cabins: Cabin[]) => void }) {
  const label = cabinOptions.filter((option) => selected.includes(option.id)).map((option) => option.short).join(" · ") || "Choose cabins";
  return <div className={styles.fieldWrap} data-popover><FieldButton icon={<AirplaneTilt size={23} />} title="Cabin classes" value={label} open={open} onClick={onToggle} />{open && <div className={`${styles.fieldMenu} ${styles.cabinMenu}`}>{cabinOptions.map((option) => {
    const active = selected.includes(option.id);
    return <button key={option.id} className={active ? styles.selectedOption : ""} onClick={() => onChange(active ? selected.filter((item) => item !== option.id) : [...selected, option.id])}><span className={styles.cabinCode}>{option.code}</span><span>{option.name}</span><Check size={15} weight="bold" /></button>;
  })}<p>Select one or more cabins. Roam compares each separately.</p></div>}</div>;
}

function TravelerStepper({ count, onChange }: { count: number; onChange: (count: number) => void }) {
  return <div className={styles.travelerField} aria-label="Travelers">
    <span className={styles.fieldIcon}><User size={23} /></span>
    <span className={styles.fieldCopy}><small>Travelers</small><strong>{travelerLabel(count)}</strong></span>
    <div className={styles.travelerControls}>
      <button aria-label="Remove traveler" disabled={count <= 1} onClick={() => onChange(count - 1)}><Minus size={15} weight="bold" /></button>
      <output aria-live="polite">{count}</output>
      <button aria-label="Add traveler" disabled={count >= 9} onClick={() => onChange(count + 1)}><Plus size={15} weight="bold" /></button>
    </div>
  </div>;
}

function PointsPicker({ value, selectedCards, selectedPrograms, cardBalances, programBalances, open, onToggle, onToggleCard, onToggleProgram, onCardBalance, onProgramBalance, onClear }: {
  value: string;
  selectedCards: CreditCardProgramId[];
  selectedPrograms: AwardProgramId[];
  cardBalances: Partial<Record<CreditCardProgramId, string>>;
  programBalances: Partial<Record<AwardProgramId, string>>;
  open: boolean;
  onToggle: () => void;
  onToggleCard: (id: CreditCardProgramId) => void;
  onToggleProgram: (id: AwardProgramId) => void;
  onCardBalance: (id: CreditCardProgramId, value: string) => void;
  onProgramBalance: (id: AwardProgramId, value: string) => void;
  onClear: () => void;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<"up" | "down">("up");
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const updatePlacement = () => {
      const rect = fieldRef.current?.getBoundingClientRect();
      if (!rect) return;
      const headerClearance = 80;
      const spaceAbove = rect.top - headerClearance;
      const spaceBelow = window.innerHeight - rect.bottom - 12;
      const nextPlacement = spaceAbove >= spaceBelow ? "up" : "down";
      setPlacement(nextPlacement);
      setMaxHeight(Math.max(0, Math.floor(nextPlacement === "up" ? spaceAbove : spaceBelow)));
    };
    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    return () => window.removeEventListener("resize", updatePlacement);
  }, [open]);

  return <div className={styles.fieldWrap} data-popover ref={fieldRef}>
    <FieldButton icon={<Star size={23} />} title="Points to use" value={value} open={open} onClick={onToggle} />
    {open && <div className={`${styles.fieldMenu} ${styles.pointsMenu} ${placement === "down" ? styles.pointsMenuDown : ""}`} style={maxHeight !== null ? { maxHeight } : undefined}>
      <div className={styles.pointsMenuHeader}><div><strong>Credit card programs</strong><span>Selecting a card adds its airline partners. Add balances to hide awards you cannot fund.</span></div>{(selectedCards.length > 0 || selectedPrograms.length > 0) && <button onClick={onClear}>Clear</button>}</div>
      <div className={styles.creditProgramGrid}>{CREDIT_CARD_PROGRAMS.map((card) => {
        const selected = selectedCards.includes(card.id);
        return <div key={card.id} className={`${styles.balanceOption} ${selected ? styles.selectedCardProgram : ""}`}><button onClick={() => onToggleCard(card.id)}><span>{card.name}</span><Check size={13} weight="bold" /></button><label><input inputMode="numeric" value={cardBalances[card.id] ?? ""} onChange={(event) => onCardBalance(card.id, event.target.value)} placeholder="0" aria-label={`${card.name} points balance`} /><small>pts</small></label></div>;
      })}</div>
      <div className={styles.awardProgramHeading}><strong>Airline award programs</strong><span>{selectedPrograms.length} selected</span></div>
      <div className={styles.awardProgramList}>{AWARD_PROGRAMS.map((program) => {
        const selected = selectedPrograms.includes(program.id);
        return <div key={program.id} className={`${styles.balanceOption} ${selected ? styles.selectedOption : ""}`}><button onClick={() => onToggleProgram(program.id)}><AirlineLogo code={program.carrier} name={program.name} size={23} /><span>{program.name}</span><Check size={14} weight="bold" /></button><label><input inputMode="numeric" value={programBalances[program.id] ?? ""} onChange={(event) => onProgramBalance(program.id, event.target.value)} placeholder="0" aria-label={`${program.name} points balance`} /><small>pts</small></label></div>;
      })}</div>
      <p className={styles.balanceHelp}>When any balance is entered, blank balances count as zero. Roam combines eligible card and airline balances at a nominal 1:1 transfer ratio and does not assume transfer bonuses.</p>
    </div>}
  </div>;
}

function FlightComparisonModal({ flights, onClose }: { flights: FlightRecommendation[]; onClose: () => void }) {
  const rows = buildFlightComparisonRows(flights);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return <div className={styles.modalBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`${styles.modal} ${styles.comparisonModal}`} role="dialog" aria-modal="true" aria-labelledby="comparison-modal-title">
      <button className={styles.modalClose} onClick={onClose} aria-label="Close flight comparison"><X size={18} /></button>
      <p className={styles.modalEyebrow}>Side-by-side decision support</p>
      <h2 id="comparison-modal-title">Compare verified options</h2>
      <p className={styles.comparisonIntro}>Roam&apos;s original ranks stay fixed here—even if you sorted the results rail another way.</p>
      <div className={styles.comparisonTableWrap}>
        <table className={styles.comparisonTable}>
          <thead><tr><th scope="col">Measure</th>{flights.map((flight) => <th scope="col" key={flight.id}><strong>{flight.carriers[0] ?? "Flight"}</strong><span>{flight.origin} → {flight.destination}</span></th>)}</tr></thead>
          <tbody>{rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th>{row.values.map((value, index) => <td key={`${row.label}-${flights[index].id}`}>{value}</td>)}</tr>)}</tbody>
        </table>
      </div>
      <div className={styles.itineraryActions}><button onClick={onClose}>Keep comparing</button></div>
    </section>
  </div>;
}

function FlightFiltersModal({ filters, availableCabins, availablePrograms, resultCount, onChange, onClose }: {
  filters: FlightResultFilters;
  availableCabins: string[];
  availablePrograms: Array<{ id: string; label: string }>;
  resultCount: number;
  onChange: (filters: FlightResultFilters) => void;
  onClose: () => void;
}) {
  const toggleCabin = (cabin: string) => onChange({ ...filters, cabins: toggleValue(filters.cabins, cabin) });
  const toggleProgram = (program: string) => onChange({ ...filters, programs: toggleValue(filters.programs, program) });

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={onClose}>
    <section className={`${styles.modal} ${styles.resultsFilterModal}`} role="dialog" aria-modal="true" aria-labelledby="filter-modal-title" onMouseDown={(event) => event.stopPropagation()}>
      <button className={styles.modalClose} aria-label="Close flight filters" onClick={onClose}><X size={17} /></button>
      <p className={styles.modalEyebrow}>Refine availability</p>
      <h2 id="filter-modal-title">Filter flights</h2>
      <p className={styles.filterModalIntro}>These filters apply instantly to the returned availability. Unknown fees or durations are hidden when you set a ceiling.</p>

      <div className={styles.filterModalSection}><strong>Stops</strong><div className={styles.filterPills}>{([
        ["any", "Any"], ["nonstop", "Nonstop"], ["up_to_one", "Up to 1 stop"], ["connecting", "Connecting"],
      ] as const).map(([value, label]) => <button key={value} className={filters.stops === value ? styles.filterPillActive : ""} onClick={() => onChange({ ...filters, stops: value })}>{label}</button>)}</div></div>

      <div className={styles.filterModalSection}><strong>Cabin</strong><div className={styles.filterPills}>{availableCabins.map((cabin) => <button key={cabin} className={filters.cabins.includes(cabin) ? styles.filterPillActive : ""} onClick={() => toggleCabin(cabin)}>{formatCabin(cabin)}</button>)}</div></div>

      <div className={styles.filterLimits}>
        <label><span>Max points</span><div><input inputMode="numeric" value={filters.maxPoints ?? ""} onChange={(event) => onChange({ ...filters, maxPoints: optionalNumber(digitsOnly(event.target.value)) ?? null })} placeholder="Any" /><small>per traveler</small></div></label>
        <label><span>Max fees</span><div><b>$</b><input inputMode="decimal" value={filters.maxFeesUsd ?? ""} onChange={(event) => onChange({ ...filters, maxFeesUsd: optionalNumber(decimalOnly(event.target.value)) ?? null })} placeholder="Any" /><small>USD</small></div></label>
        <label><span>Max duration</span><div><input inputMode="decimal" value={filters.maxDurationMinutes != null ? filters.maxDurationMinutes / 60 : ""} onChange={(event) => { const hours = optionalNumber(decimalOnly(event.target.value)); onChange({ ...filters, maxDurationMinutes: hours == null ? null : Math.round(hours * 60) }); }} placeholder="Any" /><small>hours</small></div></label>
      </div>

      <div className={styles.filterModalSection}><strong>Booking program</strong><div className={styles.programFilterGrid}>{availablePrograms.map((program) => <button key={program.id} className={filters.programs.includes(program.id) ? styles.filterPillActive : ""} onClick={() => toggleProgram(program.id)}><span>{program.label}</span><Check size={13} weight="bold" /></button>)}</div></div>

      <div className={styles.filterModalFooter}><button onClick={() => onChange(DEFAULT_FLIGHT_FILTERS)}>Clear all</button><button className={styles.applyFilters} onClick={onClose}>Show {resultCount.toLocaleString()} flight{resultCount === 1 ? "" : "s"}</button></div>
    </section>
  </div>;
}

function BookingModal({ flight, travelers, onClose }: { flight: FlightRecommendation; travelers: number; onClose: () => void }) {
  const carrier = flight.carriers.join(" · ") || "Carrier to confirm";
  const flightNumbers = flight.flightNumbers.join(" · ") || "To confirm";
  const aircraft = flight.aircraft.join(" · ") || "To confirm";
  const stopsLabel = flight.direct ? "Nonstop" : flight.stops != null ? `${flight.stops} stop${flight.stops === 1 ? "" : "s"}` : "Connection";
  const programName = bookingProgramName(flight.program.id, flight.program.label);
  const bookingUrl = bookingUrlForFlight({ program: flight.program.id, origin: flight.origin, destination: flight.destination, date: flight.date, cabin: flight.cabin });

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={onClose}>
    <section className={`${styles.modal} ${styles.itineraryModal}`} role="dialog" aria-modal="true" aria-labelledby="itinerary-modal-title" onMouseDown={(event) => event.stopPropagation()}>
      <button className={styles.modalClose} aria-label="Close itinerary review" onClick={onClose}><X size={17} /></button>
      <p className={styles.modalEyebrow}>Recommendation #{flight.rank} · Award itinerary</p>
      <div className={styles.itineraryHeading}>
        <AirlineLogo code={flight.carriers[0] ?? "?"} name={flight.carriers[0] ?? "Airline"} size={48} />
        <div><h2 id="itinerary-modal-title">{flight.origin} → {flight.destination}</h2><p>{carrier} · {formatCabin(flight.cabin)}</p></div>
      </div>

      <div className={styles.itineraryPrice}>
        <div><small>Points</small><strong>{flight.miles.toLocaleString()}</strong><span>per traveler</span></div>
        <div><small>Taxes &amp; fees</small><strong>{flight.taxes ? formatTaxes(flight.taxes.amount, flight.taxes.currency) : "To confirm"}</strong><span>per traveler</span></div>
        <div><small>Book through</small><strong>{programName}</strong><span>{travelers} traveler{travelers === 1 ? "" : "s"}</span></div>
      </div>

      <div className={styles.itineraryDetails}>
        <div><small>Date</small><strong>{formatAgentDate(flight.date)}</strong></div>
        <div><small>Schedule</small><strong>{formatSchedule(flight.departsAt, flight.arrivesAt)}</strong></div>
        <div><small>Duration</small><strong>{formatItineraryDuration(flight)}</strong></div>
        <div><small>Stops</small><strong>{stopsLabel}</strong></div>
        <div><small>Flight number{flight.flightNumbers.length === 1 ? "" : "s"}</small><strong>{flightNumbers}</strong></div>
        <div><small>Aircraft</small><strong>{aircraft}</strong></div>
      </div>

      {flight.connections?.length ? <div className={styles.itineraryCallout}><strong>Connection details</strong><span>{formatConnections(flight.connections)}</span></div> : null}
      {flight.positioning && <div className={styles.positioningNotice}><strong>Separate positioning required</strong><span>{[flight.positioning.before, flight.positioning.after].filter(Boolean).join(" · ")}</span><small>{flight.positioning.explanation}</small></div>}

      <div className={styles.itineraryAvailability}>
        <div><strong>{flight.remainingSeats ? `${flight.remainingSeats} seat${flight.remainingSeats === 1 ? "" : "s"} reported available` : "Seat count must be confirmed"}</strong><span>{formatAvailabilityTimestamp(flight.refreshedAt)}</span></div>
        <span className={styles.confidenceBadge}>{flight.confidence} confidence</span>
      </div>

      <div className={styles.itineraryReason}><strong>Why Roam recommends it</strong><p>{flight.reason}</p>{flight.scoreFactors.length > 0 && <div>{flight.scoreFactors.map((factor) => <span key={`${factor.label}-${factor.value}`}>{factor.label}: {factor.label === "Program" ? programName : factor.value}</span>)}</div>}</div>
      <p className={styles.bookingCaution}>Confirm the award seats and final price with {programName} before transferring points. Transfers are generally irreversible.</p>

      <div className={styles.itineraryActions}>
        <button onClick={onClose}>Keep comparing</button>
        <a href={bookingUrl} target="_blank" rel="noopener noreferrer" aria-label={`Book with ${programName} (opens in a new tab)`}>Book with {programName}<ArrowSquareOut size={17} weight="bold" /></a>
      </div>
    </section>
  </div>;
}

function formatCabin(cabin: string) {
  return { economy: "Economy", premium: "Premium Economy", premium_economy: "Premium Economy", business: "Business", first: "First" }[cabin] ?? cabin;
}

function formatTaxes(taxes: number, currency?: string) {
  try { return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(taxes); }
  catch { return `${taxes} ${currency ?? "USD"}`; }
}

function formatConnections(connections: Array<{ airport: string; layoverMinutes?: number }>) {
  return connections.map(({ airport, layoverMinutes }) => `${airport}${layoverMinutes != null ? ` (${formatDuration(layoverMinutes)})` : ""}`).join(" · ");
}

function formatDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours ? `${hours}h${remainder ? ` ${remainder}m` : ""}` : `${remainder}m`;
}

function formatItineraryDuration(flight: FlightRecommendation) {
  if (flight.durationMinutes != null) return formatDuration(flight.durationMinutes);
  if (flight.departsAt && flight.arrivesAt) {
    const elapsed = Math.round((Date.parse(flight.arrivesAt) - Date.parse(flight.departsAt)) / 60_000);
    if (Number.isFinite(elapsed) && elapsed >= 0) return formatDuration(elapsed);
  }
  return "To confirm";
}

function formatAgentDate(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function formatAvailabilityTimestamp(value?: string) {
  if (!value) return "Availability time not provided";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Availability time not provided";
  return `Last checked ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date)}`;
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function digitsOnly(value: string): string { return value.replace(/\D/g, ""); }
function travelerCountFromLabel(value: string): number { return Math.min(9, Math.max(1, Number.parseInt(value, 10) || 1)); }
function travelerLabel(count: number): string { return `${count} traveler${count === 1 ? "" : "s"}`; }
function decimalOnly(value: string): string {
  const cleaned = value.replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("")}` : whole;
}
function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
function numericBalanceRecord<T extends string>(record: Partial<Record<T, string>>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).flatMap(([key, raw]) => {
    const parsed = optionalNumber(String(raw ?? ""));
    return parsed != null && parsed > 0 ? [[key, Math.round(parsed)]] : [];
  }));
}

function readLastSearch(): LastSearchSnapshot | null {
  try {
    return parseLastSearchSnapshot(window.localStorage.getItem(LAST_SEARCH_STORAGE_KEY));
  } catch {
    return null;
  }
}

function clearLastSearch() {
  try {
    window.localStorage.removeItem(LAST_SEARCH_STORAGE_KEY);
    window.localStorage.setItem(CLEARED_LAST_SEARCH_STORAGE_KEY, "true");
  } catch {
    // Storage can be unavailable in privacy modes; clearing the visible search still succeeds.
  }
}

function hasClearedLastSearch() {
  try {
    return window.localStorage.getItem(CLEARED_LAST_SEARCH_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeLastSearch(snapshot: LastSearchSnapshot) {
  try {
    window.localStorage.removeItem(CLEARED_LAST_SEARCH_STORAGE_KEY);
    window.localStorage.setItem(LAST_SEARCH_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Storage can be unavailable in privacy modes; search should still work normally.
  }
}

function isCreditCardProgramId(id: string): id is CreditCardProgramId {
  return CREDIT_CARD_PROGRAMS.some((program) => program.id === id);
}

function isAwardProgramId(id: string): id is AwardProgramId {
  return AWARD_PROGRAMS.some((program) => program.id === id);
}
function hasEnteredBalances(...records: Array<Partial<Record<string, string>>>): boolean {
  return records.some((record) => Object.values(record).some((value) => optionalNumber(value ?? "") != null && Number(value) > 0));
}
function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 1_000) return `${elapsedMs}ms`;
  return `${(elapsedMs / 1_000).toFixed(elapsedMs < 10_000 ? 1 : 0)}s`;
}

function parseDate(value: string) { return new Date(`${value}T12:00:00`); }
function toDateKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
function todayAtMidnight() { const today = new Date(); return new Date(today.getFullYear(), today.getMonth(), today.getDate()); }
function calendarDays(month: Date) { const first = new Date(month.getFullYear(), month.getMonth(), 1); const cursor = new Date(month.getFullYear(), month.getMonth(), 1 - first.getDay()); return Array.from({ length: 42 }, (_, index) => new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + index)); }
function formatDateRange(start: string, end: string) {
  if (!start) return "Choose dates";
  const startDate = parseDate(start);
  if (!end) return startDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const endDate = parseDate(end);
  if (startDate.getFullYear() === endDate.getFullYear() && startDate.getMonth() === endDate.getMonth()) return `${startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${endDate.getDate()}, ${endDate.getFullYear()}`;
  return `${startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${endDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}
