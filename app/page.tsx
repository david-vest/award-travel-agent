"use client";

import {
  AirplaneTilt, ArrowsDownUp, ArrowLeft, ArrowRight, CalendarBlank, CaretDown,
  CaretLeft, CaretRight, Check, CheckCircle, GlobeHemisphereWest, LockKey,
  Funnel, MagnifyingGlass, MapPin, PaperPlaneTilt, Sparkle, Star, Trophy, User, X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AWARD_PROGRAMS, CREDIT_CARD_PROGRAMS, type AwardProgramId, type CreditCardProgramId } from "../src/domain/programs";
import type { FlightRecommendation, TripRequest } from "../src/contracts/travel-search";
import { AirlineLogo } from "./AirlineLogo";
import { activeFlightFilterCount, applyFlightControls, DEFAULT_FLIGHT_FILTERS, FLIGHT_SORT_OPTIONS, type FlightResultFilters, type FlightSort } from "./flight-results";
import { useAgentRun } from "./useAgentRun";
import styles from "./page.module.css";

type LocationOption = {
  kind: "airport" | "city" | "group" | "custom"; code: string; city: string; country: string; airports: string[];
};

type Cabin = "economy" | "premium" | "business" | "first";
type OpenPanel = "origin" | "destinations" | "dates" | "cabins" | "travelers" | "points" | "airlines" | null;

const researchSteps = [
  { title: "Search live award space", evidence: "Seats.aero availability" },
  { title: "Verify itinerary and program context", evidence: "Flight details + retrieved rules" },
  { title: "Rank by total value", evidence: "Deterministic value model" },
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

const airlineOptions = [
  { code: "NH", name: "ANA" }, { code: "JL", name: "Japan Airlines" },
  { code: "UA", name: "United" }, { code: "KE", name: "Korean Air" },
  { code: "BR", name: "EVA Air" },
];

const simpleOptions = { travelers: ["1 traveler", "2 travelers", "3 travelers", "4 travelers"] };


export default function Home() {
  const [origin, setOrigin] = useState(originInitial);
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
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const [notes, setNotes] = useState("");
  const [activeFlight, setActiveFlight] = useState(0);
  const [bookingOpen, setBookingOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [flightSort, setFlightSort] = useState<FlightSort>("recommended");
  const [resultFilters, setResultFilters] = useState<FlightResultFilters>(DEFAULT_FLIGHT_FILTERS);
  const railRef = useRef<HTMLDivElement>(null);
  const [followUp, setFollowUp] = useState("");
  const agentRun = useAgentRun();
  const allFlights = agentRun.recommendations;
  const flights = useMemo(() => applyFlightControls(allFlights, flightSort, resultFilters), [allFlights, flightSort, resultFilters]);
  const filterCount = activeFlightFilterCount(resultFilters);
  const availableCabins = useMemo(() => [...new Set(allFlights.map((flight) => flight.cabin))], [allFlights]);
  const availablePrograms = useMemo(() => [...new Map(allFlights.map((flight) => [flight.program.id, flight.program])).values()], [allFlights]);
  const running = agentRun.status === "running";
  const activeFlightIndex = Math.min(activeFlight, Math.max(0, flights.length - 1));

  const changeResultFilters = (next: FlightResultFilters) => {
    setResultFilters(next);
    setActiveFlight(0);
    railRef.current?.scrollTo({ left: 0 });
  };

  const runSearch = () => {
    if (running) return;
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
            <AirportPicker title="From" icon={<MapPin size={23} />} value={[origin]} multiple={false} open={openPanel === "origin"} onToggle={() => setOpenPanel(openPanel === "origin" ? null : "origin")} onChange={(value) => { setOrigin(value[0]); setOpenPanel(null); }} />
            <AirportPicker title="Possible destinations" icon={<GlobeHemisphereWest size={23} />} value={destinations} multiple open={openPanel === "destinations"} onToggle={() => setOpenPanel(openPanel === "destinations" ? null : "destinations")} onChange={setDestinations} />
            <DatePicker start={startDate} end={endDate} flexDays={flexDays} open={openPanel === "dates"} onToggle={() => setOpenPanel(openPanel === "dates" ? null : "dates")} onDatesChange={(start, end) => { setStartDate(start); setEndDate(end); }} onFlexChange={setFlexDays} />
            <CabinPicker selected={cabins} open={openPanel === "cabins"} onToggle={() => setOpenPanel(openPanel === "cabins" ? null : "cabins")} onChange={setCabins} />
            <SimpleField icon={<User size={23} />} title="Travelers" value={travelers} options={simpleOptions.travelers} open={openPanel === "travelers"} onToggle={() => setOpenPanel(openPanel === "travelers" ? null : "travelers")} onChange={(value) => { setTravelers(value); setOpenPanel(null); }} />
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
                {openPanel === "airlines" && <div className={styles.airlineMenu}>{airlineOptions.map((airline) => {
                  const selected = preferredAirlines.includes(airline.code);
                  return <button key={airline.code} className={selected ? styles.selectedOption : ""} onClick={() => setPreferredAirlines((current) => selected ? current.filter((code) => code !== airline.code) : [...current, airline.code])}><AirlineLogo code={airline.code} name={airline.name} size={25} /><span>{airline.name}</span><Check size={14} weight="bold" /></button>;
                })}</div>}
              </div>
              <label className={styles.limitField}><span>Max taxes &amp; fees</span><div><b>$</b><input inputMode="decimal" value={maxFees} onChange={(event) => setMaxFees(decimalOnly(event.target.value))} placeholder="Any" aria-label="Maximum taxes and fees per traveler in USD" /><small>USD / traveler</small></div></label>
            </div>
          </div>

          <label className={styles.textLabel}><span>Anything else Roam should know?</span><div className={styles.notesInput}><input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="e.g., avoid early departures, prefer window seats…" /><PaperPlaneTilt size={20} /></div></label>
          <button className={styles.planButton} onClick={runSearch} disabled={running}>{running ? "Planning your trip" : "Plan my trip"}{running ? <Sparkle size={20} weight="fill" /> : <ArrowRight size={20} weight="bold" />}</button>
          <p className={styles.privacyNote}><LockKey size={14} /> Roam searches live award space and program rules in real time.</p>
        </section>

        <section className={styles.researchPanel} aria-labelledby="research-heading">
          <div className={styles.researchHeader}>
            <div><h2 id="research-heading">Roam&apos;s research</h2><p>I&apos;m working across live award space and program rules to find the best value for you.</p></div>
            <div className={styles.timestamp}><span>{agentRun.threadId ? `Thread ${agentRun.threadId.slice(0, 8)}` : "Ready to search"}</span><strong><i />{running ? "In progress" : agentRun.status === "error" ? "Needs attention" : agentRun.status === "complete" ? "Complete" : "Ready"}</strong></div>
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
            <div className={styles.resultsHeader}><div><h3 id="results-heading">Recommended flights</h3><p>{allFlights.length ? `${flights.length.toLocaleString()} of ${allFlights.length.toLocaleString()} options${filtersOpen || filterCount ? " shown" : ""}` : running ? "Searching live award space" : agentRun.status === "complete" ? "No matching options for this exact brief" : "Submit a trip brief to see verified options"}</p></div><div className={styles.carouselControls}><button onClick={() => moveCarousel(activeFlightIndex - 1)} disabled={activeFlightIndex === 0 || flights.length === 0} aria-label="Previous flight"><ArrowLeft size={18} /></button><button onClick={() => moveCarousel(activeFlightIndex + 1)} disabled={activeFlightIndex === flights.length - 1 || flights.length === 0} aria-label="Next flight"><ArrowRight size={18} /></button></div></div>
            {allFlights.length > 0 && <div className={styles.resultsToolbar}>
              <label className={styles.sortControl}><ArrowsDownUp size={15} /><span>Sort</span><select value={flightSort} onChange={(event) => { setFlightSort(event.target.value as FlightSort); setActiveFlight(0); railRef.current?.scrollTo({ left: 0 }); }}>{FLIGHT_SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><CaretDown size={12} weight="bold" /></label>
              <button className={filterCount ? styles.filtersActive : ""} onClick={() => setFiltersOpen(true)}><Funnel size={15} weight={filterCount ? "fill" : "regular"} />Filters{filterCount > 0 && <span>{filterCount}</span>}</button>
              {(filterCount > 0 || flightSort !== "recommended") && <button className={styles.clearResultsControls} onClick={() => { changeResultFilters(DEFAULT_FLIGHT_FILTERS); setFlightSort("recommended"); }}>Reset</button>}
            </div>}
            <div className={styles.flightRail} ref={railRef} onScroll={syncCarousel} tabIndex={0} aria-label="All verified flight options">
              {flights.map((flight, index) => <article className={`${styles.flightCard} ${flight.rank === 1 ? styles.roamPick : ""} ${index === activeFlightIndex ? styles.activeCard : ""}`} key={`${flight.id}-${flight.cabin}`} onClick={() => moveCarousel(index)}>
                {flight.rank === 1 && <span className={styles.pickBadge}><Star size={12} weight="fill" /> Roam&apos;s pick</span>}
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
                <div className={styles.reason}><strong>{flight.rank === 1 ? "Why it leads" : "Why it works"}</strong><p>{flight.reason}</p></div>
                <button onClick={(event) => { event.stopPropagation(); setActiveFlight(index); setBookingOpen(true); }}>Review itinerary <ArrowRight size={18} weight="bold" /></button>
              </article>)}
              {!flights.length && <div className={styles.emptyResults}>{agentRun.error ? agentRun.error : running ? "Roam is checking live award availability…" : allFlights.length ? "No flights match these result filters. Clear or widen a filter to see more options." : "Your ranked, grounded recommendations will appear here."}</div>}
            </div>
            {flights.length > 0 && <><div className={styles.scrollTrack}><span style={{ width: `${100 / flights.length}%`, transform: `translateX(${activeFlightIndex * 100}%)` }} /></div><p className={styles.scrollHint}>Best match first · scroll to compare every verified option.</p></>}
            <div className={styles.followUp}><input value={followUp} onChange={(event) => setFollowUp(event.target.value)} placeholder="Ask Roam a follow-up…" onKeyDown={(event) => { if (event.key === "Enter" && followUp.trim() && !running) { void agentRun.start({ message: followUp.trim() }); setFollowUp(""); } }} /><button disabled={!followUp.trim() || running} onClick={() => { if (followUp.trim()) { void agentRun.start({ message: followUp.trim() }); setFollowUp(""); } }}><PaperPlaneTilt size={16} /></button></div>
            {agentRun.answer && <div className={styles.agentAnswer}><div className={styles.agentAnswerLabel}><Sparkle size={15} weight="fill" /> Roam&apos;s analysis</div><ReactMarkdown remarkPlugins={[remarkGfm]}>{agentRun.answer}</ReactMarkdown></div>}
          </section>
        </section>
      </main>

      {bookingOpen && flights[activeFlightIndex] && <BookingModal flight={flights[activeFlightIndex]} onClose={() => setBookingOpen(false)} />}
      {filtersOpen && <FlightFiltersModal filters={resultFilters} availableCabins={availableCabins} availablePrograms={availablePrograms} resultCount={flights.length} onChange={changeResultFilters} onClose={() => setFiltersOpen(false)} />}
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

  const display = multiple ? value.map((item) => item.city).join(" + ") : value[0].kind === "custom" ? value[0].city : `${value[0].code} · ${value[0].city}`;
  const select = (option: LocationOption) => {
    if (!multiple) { onChange([option]); setQuery(""); return; }
    const selected = value.some((item) => item.code === option.code);
    const next = selected ? value.filter((item) => item.code !== option.code) : [...value, option];
    if (next.length) onChange(next);
  };

  return <div className={styles.fieldWrap} data-popover><FieldButton icon={icon} title={title} value={display} open={open} onClick={onToggle} />{open && <div className={`${styles.fieldMenu} ${styles.airportMenu}`}>
    {multiple && <div className={styles.selectedLocations}>{value.map((item) => <button key={item.code} onClick={() => select(item)}>{item.city}<X size={12} /></button>)}</div>}
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
  const startValue = parseDate(start); const endValue = end ? parseDate(end) : null;
  const selectDay = (day: Date) => {
    if (day < todayAtMidnight()) return;
    if (!start || end || day < startValue) onDatesChange(toDateKey(day), "");
    else onDatesChange(start, toDateKey(day));
  };

  return <div className={styles.fieldWrap} data-popover><FieldButton icon={<CalendarBlank size={23} />} title="Travel window" value={formatDateRange(start, end)} badge={flexDays ? `± ${flexDays} days` : "Exact"} open={open} onClick={onToggle} />{open && <div className={`${styles.fieldMenu} ${styles.calendarMenu}`}>
    <div className={styles.calendarHeader}><button aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><CaretLeft size={16} /></button><strong>{month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</strong><button aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><CaretRight size={16} /></button></div>
    <div className={styles.weekdays}>{["S", "M", "T", "W", "T", "F", "S"].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
    <div className={styles.calendarGrid}>{days.map((day) => {
      const key = toDateKey(day); const outside = day.getMonth() !== month.getMonth();
      const disabled = day < todayAtMidnight(); const selected = key === start || key === end;
      const inRange = endValue && day > startValue && day < endValue;
      return <button key={key} disabled={disabled} className={`${outside ? styles.outsideMonth : ""} ${selected ? styles.selectedDay : ""} ${inRange ? styles.inRange : ""}`} onClick={() => selectDay(day)}>{day.getDate()}</button>;
    })}</div>
    <div className={styles.flexPicker}><span>Flexible dates</span><div>{[0, 1, 2, 3, 7].map((days) => <button key={days} className={flexDays === days ? styles.filterActive : ""} onClick={() => onFlexChange(days)}>{days ? `±${days}` : "Exact"}</button>)}</div></div>
  </div>}</div>;
}

function CabinPicker({ selected, open, onToggle, onChange }: { selected: Cabin[]; open: boolean; onToggle: () => void; onChange: (cabins: Cabin[]) => void }) {
  const label = cabinOptions.filter((option) => selected.includes(option.id)).map((option) => option.short).join(" · ");
  return <div className={styles.fieldWrap} data-popover><FieldButton icon={<AirplaneTilt size={23} />} title="Cabin classes" value={label} open={open} onClick={onToggle} />{open && <div className={`${styles.fieldMenu} ${styles.cabinMenu}`}>{cabinOptions.map((option) => {
    const active = selected.includes(option.id);
    return <button key={option.id} className={active ? styles.selectedOption : ""} onClick={() => { const next = active ? selected.filter((item) => item !== option.id) : [...selected, option.id]; if (next.length) onChange(next); }}><span className={styles.cabinCode}>{option.code}</span><span>{option.name}</span><Check size={15} weight="bold" /></button>;
  })}<p>Select one or more cabins. Roam compares each separately.</p></div>}</div>;
}

function SimpleField({ icon, title, value, options, open, onToggle, onChange }: { icon: React.ReactNode; title: string; value: string; options: readonly string[]; open: boolean; onToggle: () => void; onChange: (value: string) => void }) {
  return <div className={styles.fieldWrap} data-popover><FieldButton icon={icon} title={title} value={value} open={open} onClick={onToggle} />{open && <div className={styles.fieldMenu}>{options.map((option) => <button key={option} className={option === value ? styles.selectedOption : ""} onClick={() => onChange(option)}>{option}<Check size={15} weight="bold" /></button>)}</div>}</div>;
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

function BookingModal({ flight, onClose }: { flight: FlightRecommendation; onClose: () => void }) {
  const program = flight.program.label;

  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={onClose}>
    <section className={styles.modal} role="dialog" aria-modal="true" aria-label="Booking steps" onMouseDown={(event) => event.stopPropagation()}>
      <button className={styles.modalClose} aria-label="Close booking steps" onClick={onClose}><X size={17} /></button>
      <p className={styles.modalEyebrow}>Recommended award itinerary</p>
      <h2>{flight.carriers[0] ?? "Award flight"} {formatCabin(flight.cabin)}</h2>
      <div className={styles.modalRoute}><strong>{flight.origin} → {flight.destination}</strong><span>{formatAgentDate(flight.date)} · {flight.stops === 0 ? "Nonstop" : `${flight.stops} stop${flight.stops === 1 ? "" : "s"}`}{flight.connections?.length ? ` via ${formatConnections(flight.connections)}` : ""}</span></div>
      <div className={styles.modalPrice}>{flight.miles.toLocaleString()} points {flight.taxes ? `+ ${formatTaxes(flight.taxes.amount, flight.taxes.currency)}` : ""}<span>Book through {program}</span></div>
      {flight.positioning && <div className={styles.positioningNotice}><strong>Separate positioning required</strong><span>{[flight.positioning.before, flight.positioning.after].filter(Boolean).join(" · ")}</span><small>{flight.positioning.explanation}</small></div>}
      <ol>
        <li><span>1</span><div><strong>Confirm the seats</strong><p>Availability is live when possible; check the award program before transferring points.</p></div></li>
        <li><span>2</span><div><strong>Transfer points</strong><p>Move only the points needed to {program}. Transfers generally cannot be reversed.</p></div></li>
        <li><span>3</span><div><strong>Complete booking</strong><p>Finish the reservation on the program’s site and save the confirmation number.</p></div></li>
      </ol>
      <button className={styles.planButton} onClick={onClose}>Got it <ArrowRight size={18} /></button>
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

function formatSchedule(departsAt?: string, arrivesAt?: string) {
  if (!departsAt) return "Schedule pending";
  const formatter = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  const depart = new Date(departsAt);
  const arrive = arrivesAt ? new Date(arrivesAt) : null;
  return `${formatter.format(depart)}${arrive ? ` – ${formatter.format(arrive)}` : ""}`;
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function digitsOnly(value: string): string { return value.replace(/\D/g, ""); }
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
  const startDate = parseDate(start);
  if (!end) return startDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const endDate = parseDate(end);
  if (startDate.getFullYear() === endDate.getFullYear() && startDate.getMonth() === endDate.getMonth()) return `${startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${endDate.getDate()}, ${endDate.getFullYear()}`;
  return `${startDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${endDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}
