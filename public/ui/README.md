# Minecraft UI assets

GUI PNGs in this directory are copied from the supplied `assets/minecraft-client.jar` (Minecraft Java Edition). `widget-*` originate in `assets/minecraft/textures/gui/sprites/widget/`; `popup-background.png` originates in `sprites/popup/background.png`; the menu textures originate in `assets/minecraft/textures/gui/`.

CSS uses the JAR's nine-slice metadata: button border 3, disabled button border 1, popup border 6. Keep nearest-neighbor rendering and do not stretch the corner pixels.

`relic-legends.png` is the supplied `assets/minecraft_title_2.png`, unchanged. These small static assets ship with the web UI so the controls also render before server-side Minecraft asset setup.
