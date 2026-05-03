# Aktueller Task
StreamManager Architektur – FERTIG

# Ergebnis
Alle Streams (A-Serie + H-Serie) laufen auf allen Plattformen (Windows + macOS).

# Lösung
Beide Stream-Typen über Nginx-Proxy auf vafrum-core.de (gleiche Origin):
- A-Serie: /api/stream-mjpeg?tunnel=HOST&serial=SERIAL (Nginx → Tunnel → MJPEG)
- H-Serie: /api/stream-ws?tunnel=HOST&src=cam_SERIAL (Nginx → Tunnel → MSE)

# Geänderte Dateien
- vafrum-core-client/main.js – StreamManager (Gruppen 1/2, Platform-TLS getrennt)
- vafrum-bridge-desktop/main.js – StreamManager (gleiche Architektur)
- vafrum-core-web/src/app/[locale]/(dashboard)/printers/page.tsx – StreamASeries nutzt /api/stream-mjpeg Proxy
- vafrum-core-web/src/app/[locale]/(dashboard)/printers/printers/page.tsx – gleiche Änderung
- /etc/nginx/sites-enabled/vafrum-core.de.conf – Neuer location = /api/stream-mjpeg Block
