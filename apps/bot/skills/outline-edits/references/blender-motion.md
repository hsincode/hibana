# 3D, Geometrie und Bewegung

## Themenanpassung und Outline-Look

Ein überzeugender Edit braucht eine erkennbare Form und korrekte wichtige Details. Bei technischen Themen Variante und Bauzustand festlegen, dann Proportionen und Anordnung anhand von Fotos, Zeichnungen oder geeigneten Originalquellen prüfen. Ein Online-Modell zuerst in den späteren Ansichten ansehen; seine Bezeichnung allein beweist keine Richtigkeit. Lizenz und Herkunft dokumentieren.

Für den bisherigen Look funktionieren blickdichte, sehr dunkle Flächen mit weißen Silhouetten, Materialgrenzen und ausgewählten technischen Kanten. Freestyle, Line Art oder gezielt erzeugte Konturkurven nach verwendeter Blender-Version und Renderer wählen. Nicht sämtliche Triangulationskanten anzeigen. Feine Nähte brauchen häufig eigene Ausschluss-Collections, damit Bloom keine weißen Klumpen erzeugt. Linienbreite an der finalen Bildauflösung beurteilen, nicht nur im Viewport.

Bei einem Render für späteren Text hinter dem Objekt: Hintergrund transparent exportieren, Körper selbst schwarz und blickdicht. Fehlende Abschlussflächen nicht durch Welt-Hintergrund oder Fade kaschieren. Dünne Umrisse eines Körpers sind keine gültige Verdeckungsmaske.

## Geometrie gezielt prüfen

- Sehr nahe Ansichten von Einlässen/Düsen, Halterungen, Flossenwurzeln, ineinandergreifenden Stufen und Abschlüssen rendern.
- Reale Durchlässe modellieren, wo die Kamera hineinfährt. Eine geschlossene Scheibe quer durch eine Düse ist ein sichtbarer Fehler. Hohlräume müssen trotzdem sinnvolle blickdichte Innenwände und einen passenden Abschluss haben.
- Benachbarte Glocken, Flossen und Rumpf getrennt kontrollieren. Ein korrektes Objekt im neutralen Zustand kann während einer Drehung problematisch aussehen.
- Offene Netzkanten oder BVH-Überschneidungen als Hinweise betrachten, nicht automatisch als Fehler: Steckverbindungen und absichtliche Hohlräume sind möglich. Sichtbare kritische Stellen entscheiden.
- Bei einer reinen Effektrevision die bewährte Geometrie nicht austauschen. Geometrie-Fingerprint oder ein gezielter Szenenvergleich kann unbeabsichtigte Änderungen ausschließen.

## Ein Kamerazug statt mehrerer wechselnder Ziele

Kamera auf ein tatsächliches Detail im Modell ausrichten. Den Zielpunkt mit der Objekttransformation in Weltkoordinaten überführen; er darf während der Objektdrehung nicht unbeabsichtigt im Raum stehen bleiben. Entfernung und Ausrichtungswinkel als zusammenhängende Kurven führen. Für eine reine Annäherung Entfernung monoton verringern; Logarithmus der Entfernung kann bei großer Spannweite eine besser steuerbare Interpolation ergeben.

Ein konstanter oder nachvollziehbar animierter Bildwinkel, sanfte Ausrichtung und echte Objektrotation waren hier überzeugender als digitaler Bildzoom mit neu gesetztem Kameraziel. Andere Referenzen dürfen andere Kamerafahrten verlangen.

`to_track_quat('-Z','Y')` pro Bild kann an einer Polausrichtung plötzlich um 180 Grad kippen. Stattdessen eine stabile Bezugsrichtung oder den vorherigen Kamera-Up-Vektor verwenden. `scripts/blender_motion.py` enthält `aim_camera`, das eine kontinuierlich fortgeführte Up-Richtung zurückgibt. Den gewünschten Roll separat addieren; nicht wiederholt auf den bereits gerollten Up-Vektor aufschlagen.

## Achse und Drehmitte ausdrücklich modellieren

„Horizontal liegend um die vertikale Achse drehen“ bedeutet Welt-Yaw um die eigene Mitte, nicht Rollen um die Längsachse und nicht Umkreisen eines entfernten Ursprungs. In Blender mit Welt-Z als Up gilt für Quaternionen `q_world @ q_base`; `q_base @ q_local` beschreibt eine andere Drehung. Der Helfer `rotate_world` setzt diese Reihenfolge um; ihm die anfängliche Weltorientierung `obj.matrix_world.to_quaternion()` übergeben. Bei Rigs, Constraints oder Scherung die vorhandene Struktur berücksichtigen.

Ein gemeinsames Empty in der tatsächlichen geometrischen Mitte vereinfacht ein zusammengebautes Modell. `make_center_pivot` erhält die sichtbaren Welttransformationen der übergebenen Wurzelobjekte. Bestehende Animations-/Rig-Strukturen vorher berücksichtigen, nicht wahllos umparenten.

Geschwindigkeiten aus aufeinanderfolgenden Positionen/Quaternionen bestimmen. Die kürzeste Quaternion-Winkeldifferenz verwenden, `q` und `-q` sind dieselbe Orientierung. Hohe Geschwindigkeit im kurzen Shake ist von der ruhigen Intro-Kamera zu unterscheiden. Nur relevante Kameraabschnitte auf Sprünge prüfen.

## Renderökonomie

Erst wenige kritische Bilder und einen kurzen Clip, dann den Export. PNG-Sequenzen oder kurze Szenen-Caches behalten. Unveränderte Abschnitte wiederverwenden, neue Cache-Pfade klar zuordnen. Alte Renderdateien nie versehentlich als neu ausgeben. Mehrere Blender-Prozesse nur bei vorhandenen Ressourcen sinnvoll einsetzen; nicht automatisch alle CPU-Kerne pro Prozess belegen.
