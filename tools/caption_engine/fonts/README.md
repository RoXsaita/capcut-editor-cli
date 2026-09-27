# Bundled caption fonts

## Active: Changa ExtraBold (option 3)

`Changa-ExtraBold.ttf` is a static Weight=800 instance of the OFL-licensed
Changa variable font from https://github.com/google/fonts/tree/main/ofl/changa.
It was generated with fontTools `instantiateVariableFont(font, {"wght": 800},
updateFontNames=True)`. Internal name: family `Changa`, subfamily `ExtraBold`.
License: `OFL-Changa.txt`. Bundled SHA-256:
`9d4f3f2975844ef5c2f653fc4a0e7bc808dd377f6f115ded5f4d3df72d727f16`.

The Suheil default uses nominal 95px, rendered by the existing Pillow scale
as 90px at 1080x1920. This reproduces option 3 from the font comparison.
The editor loads the same bytes via `/caption-fonts/changa-extrabold.ttf`,
with CSS font size 90px and weight 800. White fill, single 4px outline,
20/50 placement, normalization and mixed-Latin Arial Unicode fallback stay unchanged.

## Retained for compatibility: Alexandria Black

`Alexandria-Black.ttf` is a static Weight=900 instance of the OFL-licensed
Alexandria variable font from https://github.com/google/fonts/tree/main/ofl/alexandria.
Internal name: family `Alexandria`, subfamily `Black`. License: `OFL-Alexandria.txt`.
SHA-256: `c0055b352655ac6659fbb1d3e0d50e43c1be6d923c1009f069a0a1222d1556ee`.
Its existing font URL is retained for cached previews and rollback; it is not
the active caption default.

No runtime fontTools dependency or system-wide font installation is needed.
Do not alter Arabic shaping, cue grouping, timing, placement, or existing
approved videos merely because the default font changes.
