# Dungeon Bundle — Evolution & Improvement Report

Technical report harvested from brainstorming session (2026-02-09).
Cross-referenced with current implementation status in `IDEAS.md`, `ActorPromptBuilder.ts`, and bundle architecture.

---

## 1. Trade System Overhaul

**Problem:** The current trade system allows actors to trade items that don't exist, and actors trade back and forth in loops — the same item ping-ponging between two characters.

**Proposed Solution: Stub Query for Trade Validation**

When a character initiates a `TRADE` action, a dedicated LLM sub-query should run before the trade executes. This query receives structured context about both parties:

- **Person A**: inventory, needs, personality, goals
- **Person B**: inventory, needs, personality, goals
- **What A offers**, **what B offers**

The LLM then evaluates whether the trade is satisfactory for both parties given their current state and knowledge. This prevents hallucinated trades and ensures the exchange makes narrative sense.

**Key design points:**
- The query must verify that traded items actually exist in the respective inventories
- Both parties' satisfaction should be evaluated based on their needs/goals
- The result determines whether the trade proceeds, not just the initiator's intent

**Generalization:** This same stub-query pattern should apply to other complex actions — particularly **combat** (check resources, positioning, weapon availability) and potentially **alliance negotiations**.

**Current status:** Not implemented. Current `TRADE` action is a simple item transfer with no validation query.

---

## 2. Weighted Prompt Sections with Priority Budgeting

**Idea:** Every rule, memory, lore entry, and prompt component should carry a **weight/priority value**. Before sending to the LLM, the prompt builder reduces content by removing lowest-priority items until the prompt fits within a token budget.

**Current status:** Partially implemented. `ActorPromptBuilder` already has a `priority` field per section and a `maxPromptSections` limit in `build()`. However, the system does not yet:
- Use token estimation for budget enforcement
- Support section-level multipliers
- Have a universal scoring system across all content types (memories, lore, rules)

**Proposed enhancements:**
- Add `estTokens` to each prompt section (aligns with `PromptItem` concept in IDEAS.md)
- Introduce **section multipliers** — a multiplier on an entire category (e.g., 0.5x on location memories vs 1.0x on personal memories) that scales all items within it
- Build a **universal normalized scoring system** so memories, lore, and rules can compete fairly for prompt space
- Allow individual items within a section to be pruned, not just whole sections

---

## 3. Randomized Turn Order Per Tick

**Idea:** Each tick, the order in which characters take their turns should be randomized. This prevents predictable patterns where the same actor always acts first, creating more dynamic and emergent scenarios.

**Current status:** Not implemented. Turn order appears to be deterministic (database query order).

**Implementation:** Shuffle the actor list before processing turns each tick. Simple but impactful for gameplay variety.

---

## 4. Long-Term Goal Planning (Periodic Meta-Tick)

**Idea:** At regular intervals (e.g., every 10 ticks), each NPC gets a special LLM request to plan **long-term goals**. These goals persist across ticks and guide the character's short-term decisions.

**Examples of long-term goals:**
- Build up a resource stockpile
- Form an alliance with specific characters
- Establish dominance over a territory
- Seek revenge on a specific character

**Design points:**
- Goals are stored as private internal state for each NPC
- The goal array influences the state-dependent goal matrix (existing system)
- Goals create continuity — characters work toward objectives over multiple ticks instead of acting reactively
- Player characters don't need this system — the player has their own plans "in their head"

**Current status:** Not implemented. The existing goal matrix picks goals per-tick based on state but has no persistent long-term planning.

---

## 5. World Director / Balancing System

**Idea:** A meta-level "world director" that monitors world statistics and intervenes to maintain balance. Runs less frequently than per-tick (e.g., every N ticks).

**Responsibilities:**
- **Population balance**: If goblins are all killed, the director can spawn new ones to maintain faction diversity
- **Resource balance**: Prevent spirals where one faction hoards everything
- **Atmospheric events**: Inject world events that color the entire game (a king declares taxes, a forest fire breaks out, a plague spreads)
- **Tone/mood setting**: The Dungeon Master can set atmospheric context that influences all actors' prompts

**Design points:**
- The director receives world state statistics and tries to match desired equilibrium
- Acts as a "soft hand" — nudges rather than hard overrides
- Can trigger scenario-level events that force characters to adapt their long-term plans

**Current status:** Partially conceptualized in IDEAS.md under "Director Interval + Meta Actions" (harvested from AquariumEngine). Not yet implemented.

---

## 6. Alliance System

**Idea:** Characters can form alliances (pairs or groups). Alliances are stored as deterministic world truth (not just LLM opinion).

**Mechanics:**
- Alliance members get a **group planning tick** at regular intervals — a shared LLM request where they plan collective goals
- Members share access to each other's private information (inventory, goals, state)
- A **shared memory bank** — alliance members can contribute personal memories to a collective knowledge base
- Alliances can **expel members** (explicit mechanism, not just emergent behavior)
- Betrayal is **not an explicit action** — it emerges naturally from characters whose private goals conflict with the alliance's shared goals

**Design points:**
- Alliance formation can happen through individual conversation or group interaction
- Shared knowledge creates both power (better coordination) and vulnerability (a traitor knows your secrets)
- The system drives intrigue and drama without hard-coding betrayal mechanics

**Current status:** Not implemented. IDEAS.md mentions a "Faction/Reputation System" as a future idea but with no alliance-specific design.

---

## 7. Memory Engine

Central system for storing and retrieving character experiences. This is the most architecturally significant proposed addition.

### 7.1 Core Design

Memories are **event-based**, not text-based. They record what a character experienced or witnessed:
- "I was attacked by Thomas"
- "I saw Thomas attack defenseless Anna"
- "I traded a sword for food with the merchant"

Each memory is tagged with:
- **Who**: actors involved (subject, target, witnesses)
- **What**: action/event type
- **Where**: location
- **When**: tick number
- **Memorability score**: how significant the event is (attacks are highly memorable, idle chatter is not)

### 7.2 Dynamic Memorability

The memorability of an event should be **context-dependent**, influenced by the character's current state (via the goal matrix):
- A starving character remembers finding food more vividly
- A wounded character remembers being healed more strongly
- Witnessing violence is always highly memorable

### 7.3 Search and Retrieval

The memory engine must be searchable via a **fluent builder API**:

```
memories
  .forActor(actorId)
  .atLocation(locationId)
  .involvingPerson(targetId)
  .withMinScore(0.5)
  .ranked()
  .limit(5)
```

Results are **ranked by memorability score**, with the strongest memories returned first.

**Context-sensitive querying:**
- When a character is at a location: query memories involving that location AND all people present
- When interacting with a specific person: prioritize memories involving that person, with location/other memories as secondary context
- Primary query targets get higher weight than secondary context

### 7.4 Hybrid Search (Full-Text + Vector)

Use both full-text search (SQLite FTS extension) and vector search for retrieval:
- Tag memories with searchable metadata: person names, locations, action types
- Generate embeddings for semantic similarity search
- **Combine results** using normalized scoring (percentile ranking or z-score normalization) so both search methods contribute to a single ranked result list

### 7.5 Universal Memory Store

The memory engine should be used for **all knowledge types**:
- **Personal memories**: individual experiences and observations
- **Lore**: world knowledge, history, rumors (replaces the planned lore injection system)
- **Group/alliance memories**: shared knowledge within an alliance
- **Historical events**: major world events that become common knowledge

### 7.6 Integration with Prompt Builder

Memories should be integrated **directly into the fluent prompt builder** rather than requiring separate retrieval:

```
new ActorPromptBuilder(actor, context)
  .withIdentity()
  .withMemories({ weight: 1.0 })        // personal memories
  .withLore({ weight: 0.5 })            // world lore (lower priority)
  .withAllianceMemories({ weight: 0.7 }) // shared alliance knowledge
  .build();
```

The `weight` parameter acts as a **multiplier** on the memorability scores of items retrieved from that source. This allows the prompt budget system to fairly compare memories against lore against rules when trimming the prompt.

### 7.7 Storage Backend

Consider using the framework's **key-value storage** instead of (or alongside) SQLite tables for more flexible memory storage. Keys can combine person, place, and event for efficient lookups.

**Current status:** Not implemented. There is a `memory_context` field on actors and a basic `events` table, but no dedicated memory engine with search, ranking, or hybrid retrieval.

---

## 8. Lore System Enhancements

**Idea:** The lore system (planned but not yet implemented) should be unified with the memory engine. Key additions:

- **Dynamic lore creation**: When significant events happen (e.g., a character's head is transformed into a pig's head by magic), new lore entries are automatically created
- **Lore as living history**: The world accumulates lore over time as events unfold
- **Class/role-based knowledge**: Different characters know different lore (a scholar knows history, a merchant knows trade routes)
- **Automatic relevance decay**: Old lore that hasn't been referenced loses priority over time

**Current status:** `enableLore` exists in PromptConfig but is set to `false`. The `LoreTable` interface is defined in IDEAS.md but not implemented.

---

## 9. Text Variation Arrays

**Idea:** All descriptive text strings in scenario definitions should support **arrays of alternatives** instead of single strings. When the system needs a text, it randomly selects one from the array.

**Example:**
```typescript
// Instead of:
hungerHigh: "Your stomach gnaws at you painfully."

// Support:
hungerHigh: [
  "Your stomach gnaws at you painfully.",
  "Hunger claws at your insides relentlessly.",
  "The thought of food consumes your every thought.",
  "A deep, aching emptiness fills your belly."
]
```

**Benefits:**
- Prevents repetitive narrative across ticks
- Same mechanical function, more varied storytelling
- Applies universally: need descriptions, goal descriptions, lore text, environmental descriptions

**Current status:** Not implemented. All descriptive strings in `ActorPromptBuilder` are single strings.

---

## 10. Player Character Integration

**Idea:** The player should be able to participate as a character within the world, not just observe.

**Design points:**
- Player character has the **same needs system** as NPCs (HP, hunger, energy) for world consistency
- The difference: player gives commands manually instead of via LLM
- Player character does **not** need the long-term goal planning system (that's in the player's head)
- Player character's internal state (goals, plans) is not written into prompts

**Alternative mode: God Mode**
- Player sits above the simulation and can "plant thoughts" in NPCs
- Observe and manipulate rather than participate directly
- Both modes could be available as session options

**Current status:** Partially implemented. The `hero` class exists with `create-hero` and `act` commands, but the experience could be deeper.

---

## 11. Magic / Dynamic World Mutations

**Idea:** Leverage LLM capabilities for dynamic, unpredictable world changes. Example: a wizard casts a spell that transforms a character's head into a pig's head.

**Effects:**
- The character's **text description** changes dynamically
- The character's **emotional state** is affected
- A new **lore entry** is created ("X was transformed at Y location")
- Future prompts involving this character reflect the change
- Other characters who witnessed it have it in their memories

**Current status:** Not implemented. Would require the memory engine and dynamic lore system to work fully.

---

## 12. Domain-Agnostic Engine Architecture

**Idea:** The engine should be completely domain-agnostic at its core. All scenario-specific content (actions, prompts, rules, needs) should be defined in configuration.

**Architecture vision:**
- **Core engine**: blank slate — no hardcoded text, prompts, or game-specific logic
- **Scenario templates**: pre-built packages of actions, needs, goal matrices, lore (e.g., "RPG Template", "Sci-Fi Template")
- **Fluent builders for everything**: prompt building, tick pipeline, memory queries — all configurable via fluent chains
- **Config-driven prompt strings**: all text that goes into prompts comes from config files, not code

**Tick pipeline as fluent chain:**
```typescript
tick()
  .updateWorld()
  .processEvents()
  .runDirector()         // every N ticks
  .shuffleActors()
  .processActorTurns()
  .generateNarrative()
```

Each step is a configurable module that can be added, removed, or reordered per scenario.

**Potential applications beyond games:**
- Team dynamics simulation
- Virtual training environments
- Decision support systems
- Interactive storytelling platforms

**Current status:** The codebase has good separation of concerns but is still fantasy-RPG-specific in many places. IDEAS.md documents this as a long-term vision.

---

## 13. Alternative Scenario Themes

Ideas for stress-testing engine flexibility beyond fantasy:

- **Sci-fi space station**: factions competing for resources in a confined environment
- **Political intrigue**: renaissance court or futuristic megacity with alliances, betrayals, power plays
- **Spy thriller**: secrets, hidden agendas, information asymmetry
- **Historical simulation**: medieval town with realistic social dynamics

Key requirements these themes surface:
- Intrigue and drama need the alliance system
- Political play needs the reputation/relationship system
- Spy scenarios need robust information privacy (who knows what)

---

## 14. Character Relationship System

**Idea:** A simple system tracking relationships between characters: friendship, rivalry, trust, reputation.

**Design points:**
- Relationships evolve based on witnessed events and interactions
- Relationships influence decision-making (via memory engine — "I remember Thomas attacked Anna")
- Relationships can shift over time without explicit actions
- Feeds into the alliance system (trust threshold for forming alliances)

**Current status:** Not implemented. Mentioned in IDEAS.md as "Faction/Reputation System" idea.

---

## Summary: Implementation Priority

Based on impact, dependency ordering, and architectural significance:

| Priority | Feature | Rationale |
|----------|---------|-----------|
| 1 | **Memory Engine** (§7) | Foundation for lore, relationships, trade validation, and long-term goals |
| 2 | **Trade Stub Queries** (§1) | Fixes an active bug/loop problem |
| 3 | **Randomized Turn Order** (§3) | Simple change, high impact on dynamics |
| 4 | **Text Variation Arrays** (§9) | Simple change, reduces narrative repetition |
| 5 | **Universal Scoring System** (§2) | Extends existing priority system for prompt budget |
| 6 | **Long-Term Goal Planning** (§4) | Needs memory engine; adds depth to NPC behavior |
| 7 | **World Director** (§5) | Prevents world state spirals; needs world statistics |
| 8 | **Alliance System** (§6) | Needs memory engine and relationship tracking |
| 9 | **Lore System** (§8) | Built on top of memory engine |
| 10 | **Domain-Agnostic Refactor** (§12) | Architectural evolution, do incrementally |

---

*Source: Voice brainstorming session, 2026-02-09. Original transcript in Swedish/English mix (`BRAINSTORMING_20260209.md`).*
