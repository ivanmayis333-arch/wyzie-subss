<p align="center">
  <a href="https://sub.wyzie.io/">
    <img src="https://i.postimg.cc/L5ppKYC5/cclogo.png" height="120">
    <h1 align="center">Wyzie Subs</h1>
  </a>
</p>

## A simple easy to use Subtitle Scraper API

> **This project is now closed source.** The source code is no longer publicly available.

### Features
- **Simple**: Just send a request to the API with the TMDB or IMDB ID of the movie or TV show and get the subtitles for.
- **Fast**: The API is hosted on a edge cloud provider with multiple proxies for spoofing requests (response time varies).
- **Free**: The API is completely free to use.
- **Hosted**: Available at [sub.wyzie.io](https://sub.wyzie.io).

[*Providers Status*](https://sub.wyzie.io/status)

### Request Flow Chart
![request flow chart](.github/flowchart.png)

### Usage Example

Please note: the `id` url parameter can be used interchangable with either a TMDB ID or an IMDB ID. It checks for "tt" to determine if it's an IMDB ID or not. Using a TMDB ID is slower as we have to request the IMDB ID from TMDB first.
<sup>
  All parameters work with both TMDB and IMDB IDs, aswell as shows and movies.
</sup>

![image](https://github.com/user-attachments/assets/45dec134-defb-4a2b-b466-1ec656618ac7)
