# ALAWA Project Research & Recommendation

*Prepared 10 November 2026*

## 1. The situation we are working in

| Fact | Detail |
|---|---|
| Presidential & National Assembly election | **Saturday 16 January 2027** (Electoral Act 2026 timetable) |
| Presidential campaign window | Opened 19 Aug 2026; ends 24 hours before polls (14/15 Jan 2027) |
| Governorship & State Assembly election | 6 February 2027 |
| National register of voters | 103 million+ (INEC, Oct 2026) |
| PVC collection | Nationwide collection started 9 Oct 2026 |
| Recent off-cycle PVC collection rates | Anambra 98.8%, Ekiti 97.1%, FCT 94.4%, Osun 81.5% |

**What this means:** we have about **9 weeks**. Elections in Nigeria are won at the
**polling unit** (≈176,000 units, 8,809 wards, 774 LGAs). ALAWA's strength is
**youth volunteers across Arewa**. So the most useful software organises those
volunteers so that every supporter they find **has a PVC and actually votes**.
That kind of work turns support into votes and can be measured.

## 2. Options considered

| Option | Value for winning | Can ship in 9 weeks? | Risk | Verdict |
|---|---|---|---|---|
| A. Social media / propaganda bot network | Low and falling; platforms remove it | Yes | High: breaks platform rules, damages reputation, may break the law | ❌ Rejected |
| B. Big "campaign super-app" (chat, news, payments, etc.) | Medium | No | Won't be ready in time | ❌ Too late |
| C. Election-day results "situation room" | Medium | Yes | Results collation belongs to the party's agents; ALAWA is not an accredited party agent or observer | ⚠️ Leave to APC structures |
| D. **Volunteer + Get-Out-The-Vote (GOTV) coordination app** | **High**: covers turnout, which decides close states | **Yes** | Low, if we follow data-protection law | ✅ **Recommended** |
| E. Verified achievements library (shareable on WhatsApp) | Medium-High in the North, where WhatsApp leads | Yes | Low, if every claim has a source | ✅ Include in D |

## 3. Recommendation: **ALAWA Ground Game**

A lightweight, mobile-first web app that works on cheap Android phones over weak data. It covers all five ALAWA aims:

| ALAWA aim | Feature |
|---|---|
| 1. Secularity / religious harmony | **Events**: interfaith town halls and dialogues, scheduled by state |
| 2. Youth participation | **Volunteer registry** by State → LGA → Ward → Polling Unit, with roles (ward coordinator, canvasser, transport, media) |
| 3. Highlight achievements | **Achievements library**: verified fact cards with a source link, in English and Hausa, plus a one-tap **Share to WhatsApp** button |
| 4. Show welfare focus | Achievement categories (education, wages, infrastructure, etc.) and community events |
| 5. Thorough campaign to win | **Supporter pledges + PVC tracker + election-day GOTV list** with a live coverage dashboard |

### The core loop
1. **Recruit**: a youth volunteer signs up and is assigned to their ward or polling unit.
2. **Canvass**: the volunteer records supporters they meet: PVC status, whether they need transport, and consent to reminders.
3. **PVC push** (now until the INEC deadline): find supporters who are missing a PVC and help them collect it.
4. **Remind**: the week before 16 Jan, export the list of supporters who agreed to reminders, for SMS or WhatsApp broadcast.
5. **Election day**: ward coordinators work through their list, marking each supporter as *reminded* and then *voted*, and send transport where needed.
6. **Dashboard**: leadership sees which states and wards have weak coverage and moves volunteers there.

### Phase plan
| When | Deliverable |
|---|---|
| Week 1 (now) | MVP live: registry, pledges, PVC tracker, facts, events, dashboard (**built in this repo**) |
| Weeks 2–3 | Onboard state coordinators; verify fact cards and add Hausa text; train volunteers |
| Weeks 3–8 | Canvassing and PVC drive; weekly coverage reviews |
| Week 9 (Jan 9–15) | Reminder broadcasts; transport plan; election-day dry run |
| 16 Jan | GOTV mode. All campaigning stops 24 h before polls; on the day, only reminders and transport within the law. |
| After 16 Jan | Reuse for the 6 Feb governorship elections |

## 4. Rules we must follow (non-negotiable)

- **No vote buying or inducements.** Under the Electoral Act, offering money or gifts for votes is a crime. The app records *transport needs* only, never payments to voters.
- **No campaigning within 24 hours of the election**, and none near polling units on election day.
- **Nigeria Data Protection Act 2023:** collect only what is needed, get explicit consent before sending reminders, never buy or scrape voter lists, keep the data secure, and delete supporter phone numbers after the elections.
- **No misinformation.** Every achievement card needs a credible source and a reviewer's approval before it is published. False claims are easy to expose and cost credibility.
- **Respect diversity.** Keep messaging free of religious or ethnic attacks, as ALAWA Aim 1 already requires.
- **Coordinate with the official campaign** (Tinubu/Shettima campaign council, APC state structures) so we add to their work instead of duplicating it.

## 5. Success metrics
- Volunteers registered per state/ward
- Supporters pledged, % with PVC
- Wards with ≥1 active coordinator (coverage)
- Supporters reminded / confirmed voted on 16 Jan

## Sources
- [Wikipedia: 2027 Nigerian general election](https://en.wikipedia.org/wiki/2027_Nigerian_general_election)
- [Guardian: INEC moves 2027 Presidential election to January 16](https://guardian.ng/politics/inec-moves-2027-presidential-election-to-january-16/)
- [Voice of Nigeria: INEC campaign timetable](https://von.gov.ng/2027-elections-inec-releases-official-campaign-timetable/)
- [WithinNigeria: revised campaign timetable](https://www.withinnigeria.com/2026/07/31/inecs-revised-campaign-timetable-for-2027-general-election/)
- [ThisDay: Register hits 103m](https://www.thisdaylive.com/2026/10/05/2027-national-register-of-voters-hits-over-103m-says-inec/)
- [Legit.ng: PVC collection starts Oct 9](https://www.legit.ng/nigeria/1734462-inec-nigerias-voter-register-hits-103-million-pvc-collection-starts-october-9/)
- [Gazette: Anambra 98.8% PVCs collected](https://gazettengr.com/98-8-pvcs-collected-for-anambra-governorship-election-inec/)
- [ICIR: Ekiti PVC collection](https://www.icirnigeria.org/?p=278300)
