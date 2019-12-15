# pod101-scraper
Scraper for <XYZ>Pod101 sites

## Quick Start

Install
```
$ npm install
$ node index.js --help
```

Provide login credentials and the hostname via environment variables
```
$ export POD101_HOSTNAME=xyzpod101.com
$ export POD101_USERNAME=my_username
$ export POD101_PASSWORD=my_password
```

Scraping is a two-phase process.

First, we crawl the site and create a definition file that contains all downloads in a specified library:
```
$ node ./index.js crawl intermediate > intermediate.json
```

We can use this definition file to start downloading the materials:
```
$ node ./index.js download intermediate.json ~/Downloads/xyzpod101
```

## Usage
```
pod101-scraper [command]

Commands:
  pod101-scraper crawl [library]         Crawl a library or level for lessons
  pod101-scraper download [def_json]     Download lessons
  [destination]

Options:
  --version       Show version number                                  [boolean]
  -u, --username  Login username                                        [string]
  -h, --hostname  Hostname of the site                                  [string]
  --help          Show help                                            [boolean]
```

Password must be provided via the `POD101_PASSWORD` environment variable.

## Fault-tolerance

Failed downloads are shown in the logs, and having at least one failed download will result in a status code 2. You have to manually retry failed downloads by running the same command. The process is incremental: successfully downloaded files are discovered by name and are skipped.
