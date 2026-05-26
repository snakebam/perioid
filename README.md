# perioid

Privé cyclus-tracker en voorspeller voor Mmieba. Volledig client-side (HTML + JS), te hosten via GitHub Pages.

## Wat het doet

- 🔒 Wachtwoord-gate (`mmiebaperiod`).
- 📅 Maandkalender met fases ingekleurd en kans op menstruatie per dag (gaussian rond de voorspelde startdatum, helderder = hogere kans).
- 📈 Grafieken: cycluslengte per maand, verdeling cycluslengtes, kans-curve voor de komende 60 dagen.
- 👩‍⚕️ Dokter-invoer: nieuwe cycli toevoegen + medische notities (observatie / symptoom / medicatie / correctie). Voorspellingen werken automatisch bij.
- 💾 Lokale opslag in de browser + JSON export/import om wijzigingen in de repo te committen.

## Voorspellingsmodel

- Neemt de laatste 6 cycluslengtes (in dagen tussen opeenvolgende start­datums).
- Berekent gemiddelde μ en standaarddeviatie σ.
- Voorspelt volgende start als `laatste_start + ronde(μ)`.
- Kans per dag = som van gaussians rond μ, 2μ, 3μ, 4μ (zodat je ook de cycli erna in de kalender ziet).
- Fases worden afgeleid van de dag in de cyclus (menstruatie 1-5, folliculair 6-11, vruchtbaar 12-16, ovulatie 14, vroege luteaal 17-23, late luteaal 24+).

## Lokaal draaien

```bash
# in deze folder
python -m http.server 8000
# open http://localhost:8000
```

Of dubbelklik `index.html` (werkt ook, fetch van `data.json` werkt in moderne browsers via `file://` niet — gebruik dan import in de **data** tab, of liever een lokale server).

## Pushen naar GitHub (gebruiker `snakebam`)

```bash
git init
git add .
git commit -m "init perioid"
git branch -M main
git remote add origin https://github.com/snakebam/perioid.git
git push -u origin main
```

Maak daarna het repo aan op github.com/snakebam (privé aanbevolen) als die nog niet bestaat, óf gebruik `gh repo create snakebam/perioid --private --source=. --push`.

## GitHub Pages

`Settings → Pages → Build from branch → main / root` aanzetten. Daarna live op `https://snakebam.github.io/perioid/`.

> Let op: GitHub Pages is publiek lees­baar. Het wachtwoord is alleen een UI-slot; de JSON staat in de repo. Houd de repo **privé** of host elders als de data echt beschermd moet zijn.

## Data committen

Na wijzigingen in de app:
1. Tab **data** → **exporteer JSON**.
2. Vervang `data.json` in de repo met het bestand.
3. `git commit -am "update data" && git push`.
