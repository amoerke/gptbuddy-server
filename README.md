# gptbuddy Router-Service

Zentraler, selbst gehosteter Router für verwaltete Codex-Installationen. Der Dienst läuft unter `https://gptbuddy.dataminer.cloud` und bewahrt den Jev-API-Schlüssel ausschließlich auf dem VPS auf. Jev ist der verbindliche Klassifizierer; bei einer positiven Route weist der Hook Codex an, anschließend einen eigenen, günstigeren GPT-Subagenten für die tatsächliche Arbeit zu verwenden.

## Sicherheitsmodell

- Der Dienst akzeptiert nur signierte Anfragen von verwalteten Clients.
- Jeder Client sendet ID, Zeitstempel und HMAC-Signatur; abgelaufene oder wiederholte Anfragen werden abgewiesen.
- Der Dienst begrenzt Anfragen pro Client und protokolliert nur Prompt-Hash, Länge und Entscheidung – nie den Prompt.
- Ausschließlich der aktuelle Prompt wird an Jev zur Klassifizierung gesendet; keine Dateien, Tool-Ausgaben oder Gesprächshistorie.
- Bei jedem Fehler lautet die Entscheidung `expert`; Codex arbeitet dann ohne Delegation weiter.

## VPS vorbereiten

1. Lege für `gptbuddy.dataminer.cloud` einen DNS-A-Record auf die öffentliche IPv4-Adresse des VPS an.
2. Installiere Docker Engine samt Compose-Plugin auf dem VPS.
3. Kopiere dieses Verzeichnis auf den VPS und erstelle daraus `.env`:

```bash
cp .env.example .env
chmod 600 .env
```

4. Trage einen dedizierten Jev-API-Schlüssel sowie den Client-Zugang in `.env` ein. Für einen einzelnen Team-Client verwende `ROUTER_CLIENT_ID` und `ROUTER_CLIENT_SECRET`; diese zwei getrennten Werte sind insbesondere in Coolify robuster als ein JSON-Wert. Für mehrere Geräte verwende in Coolify bevorzugt `ROUTER_CLIENTS_B64`, also ein Base64-kodiertes JSON-Objekt mit den Geräte-IDs und Secrets. `ROUTER_CLIENTS_JSON` bleibt als Alternative für Umgebungen verfügbar, die JSON-Werte unverändert weiterreichen.
5. Starte den Dienst:

```bash
docker compose up -d --build
docker compose logs -f
```

Die Compose-Datei enthält bewusst keinerlei Caddy-Konfiguration, Caddy-Container, Zertifikatsverwaltung oder Host-Portfreigabe. Der Router stellt Port `3000` nur innerhalb des Docker-Netzwerks bereit. In Coolify trägst du im Feld **Domains** für den Service `router` `https://gptbuddy.dataminer.cloud:3000` ein. Coolify übernimmt damit TLS und die Weiterleitung auf den internen Container-Port, ohne Port 3000 auf dem VPS zu belegen. Der öffentliche Gesundheitscheck lautet anschließend `https://gptbuddy.dataminer.cloud/healthz`; das Routing verlangt immer eine gültige Signatur.

## Managed Client ausrollen

Verteile `managed-hook/route.js` per MDM in ein geschütztes Verzeichnis auf den Teamgeräten und setze dort:

```text
GPTBUDDY_ROUTER_URL=https://gptbuddy.dataminer.cloud/v1/route
GPTBUDDY_CLIENT_ID=dataminer-managed
GPTBUDDY_CLIENT_SECRET=<identischer Wert wie in ROUTER_CLIENTS_JSON>
```

Registriere den Hook danach über die zentral verwaltete Codex-Konfiguration als `UserPromptSubmit`-Hook. Der Hook enthält keinen Provider-API-Schlüssel und fällt bei Netzwerk- oder Serverproblemen immer auf die Hauptsitzung zurück.

## Betrieb

Aktualisieren:

```bash
docker compose up -d --build
```

Client-Schlüssel rotieren: neuen Secret-Wert in `.env` und in der Geräteverwaltung hinterlegen, Container neu starten, danach den alten Wert entfernen. Für Gruppen mit unterschiedlichen Berechtigungen können mehrere Client-IDs in `ROUTER_CLIENTS_JSON` verwaltet werden. Den Jev-Modellnamen nach der Kalibrierung auf eine konkrete Version pinnen, damit die Routing-Schwellen stabil bleiben.
