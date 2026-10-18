# StarLoupe media

Video, copertine e coda di pubblicazione dei profili StarLoupe.

- `media/` — video e copertine, serviti da GitHub Pages: `https://fr3nezy.github.io/starloupe-media/media/<file>`. Instagram li scarica da qui.
- `queue/` — post in attesa, un file JSON ciascuno.
- `published/` — post pubblicati, con `media_id` e `permalink`.
- `scripts/publish.mjs` — il pubblicatore (API ufficiale di Instagram, nessuna dipendenza).
- `.github/workflows/publish.yml` — ogni 15 minuti pubblica i post in scadenza.
- `.github/workflows/refresh-tokens.yml` — rinnova i token Instagram il 1° e il 15 di ogni mese.

## Formato di un post in coda

```json
{
  "id": "002-it",
  "account": "it",
  "type": "REEL",
  "video": "media/002.mp4",
  "cover": "media/002-cover.jpg",
  "caption": "Testo del post con #hashtag",
  "publish_at": "2026-10-19T10:00:00+02:00",
  "attempts": 0
}
```

`account` sceglie il token: `it` → secret `IG_TOKEN_IT`, `en` → secret `IG_TOKEN_EN`.

## Secret necessari

| Secret | A cosa serve |
|---|---|
| `IG_TOKEN_IT` | token Instagram di @starloupe.it |
| `IG_TOKEN_EN` | token del profilo inglese (quando esiste) |
| `GH_PAT` | token GitHub con permesso "Secrets: read and write" su questo repo, per salvare i token rinnovati |

Se un post fallisce 3 volte resta in `queue/` con l'errore in `last_error`, e il workflow fallisce: GitHub manda una mail.
