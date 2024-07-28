# backend.how - hugo site

## Development 

To run server
```bash
hugo server -D --buildDrafts --buildFuture
```
To add new post
```
hugo new  content posts/{post-name}.md
```

## Deployment

## CD
- Connect github with cloudflare pages
- Select main branch and grant access.

With each commit it builds the site and publishes on cloudflare pages

## Cron
- To ensure future dated arcticle gets published build and deploy once a day.
- ./crontab/ - cloudlfare wrangle cron worker, uses deploy hook url to trigger deployment

