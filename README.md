# eInnsyn Buskerud – møter og agenda

Dette repoet inneholder både eksisterende OneNote-feeder og en liten, mobilvennlig webapp for å finne politiske møter i Buskerud.

## Webappen

Åpne `index.html` lokalt eller publiser repoet med GitHub Pages. Appen:

- viser alle kommende møter fra `einnsyn-state.json` automatisk
- har egen visning for historiske møter
- kan filtrere på søk, politisk organ, agenda-status og tidsperiode
- viser sakskart når agendaen er publisert
- bruker offentlige eInnsyn-lenker til møte, agenda og sak
- leser `feedV2.xml` for å berike agendaene med sakslenker og innstillinger

Webappen leser den offentlige projeksjonen `meetings.json` fra dette repoet. Den genereres av integrasjonsrepoets poller og publiseres ved endringer. Hele den private `einnsyn-state.json`-filen publiseres ikke.

Datagrunnlaget bygges fra:

```text
`monsivar/einnsyn-teams-integration-Buskerud-Ap/einnsyn-state.json`
```

Det betyr at webappen alltid bruker integrasjonens eksisterende datagrunnlag, men bare får en slank offentlig møteprojeksjon. `feedV2.xml` blir lest lokalt fra samme repo og fortsetter å være tilgjengelig for OneNote-flyten.

## Lokal test

For å teste med den lokale state-filen, kjør en enkel statisk server fra mappen som inneholder både integrasjonsrepoet og denne mappen, for eksempel:

```powershell
python -m http.server 4173
```

Åpne deretter `http://localhost:4173/einnsyn-onenote-feed/`. På localhost bruker appen automatisk `/einnsyn-state.json`; i publisert versjon brukes state-URL-en over.

## GitHub Pages

Workflowen `.github/workflows/pages.yml` publiserer innholdet i repoet ved push til `main`. Første gang må GitHub Pages settes til å bruke **GitHub Actions** som kilde under repoets Pages-innstillinger.

## Eksisterende OneNote-feed

`feed.xml` og `feedV2.xml` er beholdt uendret som transport for Power Automate og OneNote. Webappen er et tillegg til denne flyten, ikke en erstatning for den.
