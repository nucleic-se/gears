# AGENTS.md

## 1. Core Philosophy: User-Guided Process
This project is built **with** the user, not just **for** the user. 
- **Ask before assuming.** If a design choice is ambiguous, ask the user for preference.
- **Iterative development.** Build small, verify, then expand.

## 2. Clean Architecture
- **Separation of Concerns.** Keep the agentic logic, storage, and processing distinct.
- **Dependency Rule.** Source code dependencies should only point inwards. Inner circles (Entities) know nothing about outer circles (Database, Web).

## 3. Simplicity & No Over-Engineering
- **KISS (Keep It Simple, Stupid).** Do not add features "just in case".
- **YAGNI (You Aren't Gonna Need It).** Implement only what is required for the current task.
- **Minimal Dependencies.** Use Node.js built-ins where possible. Only reach for external libraries when they provide significant value over a simple custom implementation.

## 4. Technology Stack
- **Runtime:** Node.js
- **Language:** TypeScript (preferred for strictness) or JavaScript (if simple) - *Wait for user confirmation on TS vs JS.*
- **Architecture:** Modular, service-based (e.g., WorkerService, StorageService).

## 5. Development Rules
- code should be self-documenting.
- Comments explain *why*, not *what*.
- Tests are not an afterthought.
- **Do not change tests unless explicitly told to do so.**

