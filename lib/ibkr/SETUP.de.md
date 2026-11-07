# IBKR-Sync einrichten (Flex Web Service, nur lesend)

Das Dashboard holt Kontostand, Positionen, Tages-NAV, Einzahlungen, Dividenden und Trades einmal
täglich über den **Flex Web Service** von Interactive Brokers. Der Zugang ist rein lesend: Mit dem
Flex-Token kann man keine Orders erteilen und kein Geld bewegen. Der Token läuft je nach Einstellung
erst nach bis zu einem Jahr ab, deshalb ist kein Browser-Login nötig.

Die Menünamen unten stammen aus dem englischen Client Portal. Quellen sind die IBKR-Guides
[Create an Activity Flex Query](https://ibkrguides.com/orgportal/performanceandstatements/activityflex.htm),
[Flex Queries](https://www.ibkrguides.com/clientportal/performanceandstatements/flex.htm) und
[Configure Flex Web Service](https://www.ibkrguides.com/clientportal/performanceandstatements/flex3.htm).
Falls ein Label bei dir leicht anders heisst, nimm das nächstliegende.

## 1. Activity Flex Query anlegen

1. Im Client Portal einloggen und **Performance & Reports → Flex Queries** öffnen
   (alternativ **Menu** oben links → **Reporting → Flex Queries**).
2. Beim Kasten **Activity Flex Query** oben rechts auf das **+**-Symbol klicken.
3. Als **Query Name** z.B. `finance-dashboard` eingeben.
4. Unter **Sections** die folgenden Abschnitte einzeln anklicken. Im Pop-up jeweils
   **Select All** wählen (alle Felder) und **Save** klicken:

   | Section | Optionen im Pop-up | wofür |
   | --- | --- | --- |
   | **Account Information** | – | Konto-ID, Basiswährung (`currency`) |
   | **Net Asset Value (NAV) in Base** (im Referenzhandbuch: *NAV Summary in Base*) | – | Tages-NAV (`reportDate`, `total`, `cash`) |
   | **Open Positions** | nur **Summary** (nicht *Lot*) | Positionen, Marktwert, Einstandswert, unrealisierter G/V |
   | **Cash Transactions** | **Detail**, dazu mindestens **Deposits & Withdrawals**, **Dividends**, **Payment In Lieu Of Dividends**, **Withholding Tax** (oder einfach alle Typen) | Einzahlungen, Dividenden, Quellensteuer |
   | **Trades** | nur **Execution** (kein *Closed Lots*, *Orders*, *Symbol Summary*) | Käufe/Verkäufe |
   | **Cash Report** (optional) | Base Currency Summary | Fallback für den Cash-Bestand |

   Wichtig sind die Felder **Currency**, **FX Rate to Base**, **Date/Time** bzw. **Report Date**,
   **Amount** und **Type**. Mit **Select All** sind sie automatisch dabei.
5. **Delivery Configuration**:
   - **Accounts**: nur dein Konto (der Sync bricht ab, wenn der Report mehrere Konten enthält)
   - **Models**: Optional
   - **Format**: **XML**
   - **Period**: **Last 365 Calendar Days**
6. **General Configuration**:
   - **Date Format**: `yyyyMMdd` (`yyyy-MM-dd` geht auch)
   - **Time Format**: `HHmmss`
   - **Date/Time Separator**: `; (semi-colon)`
   - **Profit and Loss**: Default
   - **Breakout by Day?**: No
   - **Display Account Alias in Place of Account ID?**: No
7. **Continue** klicken, die Zusammenfassung prüfen und **Create** klicken.
8. Die **Query ID** notieren. Das ist die Zahl, die in der Liste der Activity Flex Queries neben
   der neuen Query steht bzw. über das Bearbeiten-/Info-Symbol angezeigt wird.

## 2. Flex Web Service aktivieren und Token erzeugen

1. **Performance & Reports → Flex Queries → Flex Web Service Configuration** öffnen
   (Zahnrad beim Kasten *Flex Web Service Configuration*; alternativ **Menu → Reporting → Flex
   Queries → Flex Web Service Configuration**).
2. Die Checkbox **Flex Web Service Status** aktivieren und **Save** klicken. Der Status muss danach
   **ACTIVE** anzeigen.
3. Neuen Token erzeugen:
   - **Should Expire After**: die längste angebotene Dauer wählen (z.B. 1 Jahr).
     Der Standard sind nur 6 Stunden.
   - **Valid For IP Address** (optional): die öffentliche IP des Mac mini eintragen, um den Token
     daran zu binden. Leer lassen heisst keine IP-Beschränkung. Wenn sich deine IP ändert, meldet
     der Sync Fehler 1013.
   - **Generate New Token** klicken. Der Token steht danach unter **Current Token Details**.
     Achtung: Ein neuer Token macht den alten sofort ungültig.

## 3. Token und Query ID im macOS-Schlüsselbund speichern

Im Terminal ausführen. Gib den Wert **nicht** auf der Befehlszeile an: Ohne Wert hinter `-w`
fragt `security` ihn verdeckt ab, deshalb landet er weder in der Shell-History noch in Logs.

```sh
security add-generic-password -s finance-dashboard-ibkr-flex -a token -w
security add-generic-password -s finance-dashboard-ibkr-flex -a query-id -w
```

Später einen neuen Token eintragen (`-U` aktualisiert den vorhandenen Eintrag):

```sh
security add-generic-password -U -s finance-dashboard-ibkr-flex -a token -w
```

## 4. Testen

```sh
bun scripts/ibkr-sync.ts --dry-run
```

Bei Erfolg erscheint eine Zeile wie
`IBKR U…: Stand 2026-10-09 · NAV CHF 1'698.30 · Positionen 1 · NAV-Tage 32 (Probelauf – … unverändert)`.
Ohne `--dry-run` wird `data/private/ibkr.json` geschrieben. Die Datei wird atomar ersetzt, und die
bisherige Historie bleibt erhalten. So wächst die NAV-Historie auch über das 365-Tage-Fenster hinaus.

Weitere Optionen:

- `--from-file <flex.xml>`: einen manuell heruntergeladenen XML-Report einlesen, ohne Netzwerk und ohne Schlüsselbund
- `--data-dir <dir>`: anderes Datenverzeichnis verwenden (Standard: `data/private` bzw. `FINANCE_DATA_DIR`)

Exit-Codes: `0` ok, `1` Fehler (Meldung auf Deutsch), `2` Token/Query ID fehlen im Schlüsselbund.

Hinweise:

- IBKR erzeugt Activity-Daten erst nach der nächtlichen Verarbeitung. Ein Lauf am frühen Morgen
  (Schweizer Zeit) liefert den Stand des Vortags.
- IBKR begrenzt die Anfragen auf 1 pro Sekunde und 10 pro Minute pro Token (Fehler 1018). Der
  Sync wartet dann automatisch.
- Ist der Token abgelaufen (Fehler 1012), im Client Portal einen neuen erzeugen (Schritt 2) und mit
  dem `-U`-Befehl oben ersetzen.
