# Compositing und Audio

## Reihenfolge

1. Zeitbezogene Titel-/Text-Ebene erstellen.
2. Bei transparent gerendertem Hintergrund den Text zunächst auf Schwarz setzen und das **blickdichte RGBA-Objekt** darüberlegen. Bei normalem Footage den Text darüberlegen oder eine echte Motivmaske verwenden. Eine vollflächig opake Aufnahme würde Text dahinter vollständig verdecken.
3. Einflug-Bewegungsunschärfe pro Objekt anwenden, wenn sie nicht korrekt im Render enthalten ist. Zwei gleichzeitig in unterschiedliche Richtungen einfliegende Objekte benötigen unterschiedliche Bewegungsvektoren. Eine gemeinsame Verschiebung des fertigen Bildes ersetzt das nicht.
4. Dezentes Kontur-Bloom nach Bedarf. Den gesamten fertigen Bildverbund aus Objekten und Text mit dem Szene-Shake verformen und die Verschiebungen über die Belichtungszeit integrieren.
5. Kein weißes Vollbild-Overlay an den Schnitten. Ein gewünschter Schluss-Fade bleibt unabhängig vom Detail-/Triebwerksübergang.

## Standalone-Helfer

`scripts/edit_effects.py` lässt sich per `importlib.util.spec_from_file_location` mit einem eindeutigen Modulnamen importieren. Nicht wieder mehrere unterschiedliche Dateien `compose` in `sys.path` mischen; das führte im alten Projekt zu zirkulären Imports.

```python
import importlib.util
from pathlib import Path
skill_path = Path("/path/to/outline-edits")  # auf den installierten Skill setzen
spec = importlib.util.spec_from_file_location("outline_effects", skill_path/"scripts/edit_effects.py")
fx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fx)
preset = fx.load_preset()
white_text = fx.code_text_layer(
    (1280, 720), time_s=t, start_s=9.5, duration_s=1.5,
    header="vehicle.system", lines=["Geprüfter kurzer Text.", "Zweite kurze Zeile."],
    font_path=font_path, position=(545, 151), font_size=20,
)
title = fx.typed_title((1280, 720), t, 9.4, .167, "> VEHICLE", font_path, (22, 600), 76)
frame = fx.composite_layers([title, white_text], rgba_subject)
frame = fx.apply_shake(frame, t, [9.3, 11.7333, 13.9], preset, strength=1.0)
```

Die Beispielzeiten stammen vom bestehenden Clip. Für neue Musik die Einsatzzeiten nach [Musik und Thema](music-driven.md) **neu bestimmen**; eine Videoreferenz ist dafür nicht nötig. Bei einem Referenzauftrag deren Timing nur übernehmen, soweit es zur gewünschten Musik passt. Positionen, Schriftgrößen und Zeilenlängen an Bildformat und Motiv anpassen. Eine Änderung zu 9:16 erfordert eine neue Komposition; bloßes Abschneiden der Seiten ist kein fertiger vertikaler Edit.

Das Preset arbeitet in Sekunden sowie normierten Bildverschiebungen; der Linsenradius richtet sich nach der längeren Bildseite, sodass Hochformat unterstützt wird. Es enthält 19 Stützpunkte über 0,6 Sekunden. PCHIP verhindert unerwünschtes Überschwingen zwischen den gemessenen Richtungswechseln. Die Stärke beeinflusst Zoom, Krümmung, Translation und Roll zusammen; bei Bedarf Kanäle gezielt neu kalibrieren. Der Helfer weist sich faltende Linsenabbildungen zurück, statt Bildfehler zu verdecken.

Die Unschärfe des Shakes stammt aus mehreren Abtastungen desselben bewegten Abbildungsfeldes. Sie ersetzt keine Objektgeschwindigkeit. `directional_blur_rgba` arbeitet mit vormultiplizierter Transparenz, damit schwarze/weiße Ränder keine falschen Halos erzeugen. Für bereits korrekt bewegungsunscharf gerenderte Objekte diese Stufe auslassen.

## Audio und Export

Die vom Nutzer vorgegebene Musik verwenden; nicht stillschweigend durch ähnliche Musik oder den alten Starship-Ton ersetzen. Start und Ende des gewünschten oder anhand der Musik gewählten Ausschnitts festhalten und die Audiospur synchron übernehmen. Ohne ausdrücklichen Wunsch weder Tempo noch Tonhöhe verändern, um sie in eine alte Zeitleiste zu zwingen. Ist bereits eine passende AAC-Spur vorhanden, sie beim MP4-Muxen kopieren. Bei notwendigem exakten Schnitt oder inkompatiblem Codec bewusst neu codieren und die Einschränkung berücksichtigen; dann keinen identischen komprimierten Hash behaupten.

Typischer Export: H.264, `yuv420p`, sinnvolle Qualitätsstufe wie CRF 15–18, gewünschte Auflösung/FPS und `+faststart`; Audio bei Kompatibilität kopieren. Werkzeugpfade ermitteln, nicht auf einen bestimmten Benutzerordner festlegen.

Den tatsächlichen Export mit FFprobe und vollständigem Decode prüfen. Bei kopiertem Audio den Hash des komprimierten Audiostreams mit der Quelle vergleichen. Einen MP4-Container-Hash nicht mit einem Audio-Hash verwechseln. Schwarze Bilder und letzte Audiopakete anhand des beabsichtigten Ablaufs bewerten; nicht pauschal jedes schwarze Bild oder eine minimale AAC-Paketlängenabweichung als Fehler erklären.

Bei einer kleinen Änderung gezielt die veränderten Frames plus kurze Vor-/Nachläufe ansehen und ein paar unveränderte Abschnitte vergleichen. Die ganze Produktion nicht ohne Anlass neu testen.
