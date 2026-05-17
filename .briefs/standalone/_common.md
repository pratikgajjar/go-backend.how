# Common rules for standalone code-archaeology posts

FIRST: read /Users/pratikgajjar/ambitious/go-backend.how/.briefs/_voice.md and follow EVERY rule.

After your first DRAFT READY, IMMEDIATELY switch to autoresearch mode:
- mkdir -p .autoresearch/<your-slug> && cd .autoresearch/<your-slug>
- Reuse the scorer at /Users/pratikgajjar/ambitious/go-backend.how/.autoresearch/score.py
- Write autoresearch.md (goal: maximum correctness + napkin math) and autoresearch.sh that runs the scorer (it prints `METRIC name=number` lines)
- init_experiment(name="<slug> correctness + napkin math", metric_name="defects", direction="lower")
- Run baseline → log_experiment → LOOP FOREVER fixing the worst category each iteration

Hard rules:
- Every code block must reference a real file path in the cached repo and the snippet must substring-match real source.
- Every number with a unit must have nearby napkin-math derivation (`= … × …` or `≈` with the working).
- Replace "approximately/roughly/about N" with measured ranges or remove the claim.
- 3000-5000 words. Hugo build clean.
- draft = true. Do not commit. Do not push.
