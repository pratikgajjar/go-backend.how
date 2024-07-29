# bakcend.how

## Development

To run server

```sh
hugo server -D --buildDrafts --buildFuture
```

To add new post

```sh
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

## License

### Code

The code for this site is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for details.

### Content

All content of this site (blog posts, images, etc.), including previously committed content, is licensed under Creative Commons Attribution-ShareAlike 4.0 International. See the [LICENSE-CONTENT](LICENSE-CONTENT) file for details.

In case of exceptions specific license is added alongside the post content.

### Exceptions

Certain documents in this repository are licensed under different terms:

- The document located at `./content/posts/the-tiger-style/index.md` is licensed under the [Apache License 2.0](./content/posts/the-tiger-style/LICENSE).
