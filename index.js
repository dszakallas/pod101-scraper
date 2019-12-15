const yargs = require('yargs');
const request = require('request');
const url = require('url');
const path = require('path');
const { promisify, callbackify } = require('util');
const cheerio = require('cheerio');
const mkdirpCb = require('mkdirp');
const numeral = require('numeral');
const fs = require('fs');
const parallelLimitCb = require('async/parallelLimit');
const limiter = require('limiter');
const { lookup } = require('lookup-dns-cache');

const client = request.defaults({ jar: true, lookup });
const post = promisify(client.post);
const get = promisify(client.get);
const mkdirp = promisify(mkdirpCb);
const parallelLimit = promisify(parallelLimitCb);
const access = promisify(fs.access);
const readFile = promisify(fs.readFile);
const rename = promisify(fs.rename);

class Media {
  constructor(name, href) {
    this.name = name;
    this.href = href;
  }
}

class Download {
  constructor(dest, srcHref) {
    this.dest = dest;
    this.srcHref = srcHref;
  }
}

class Track {
  constructor(title, description, lessonHrefs) {
    this.title = title;
    this.description = description;
    this.lessonHrefs = lessonHrefs;
  }
}

class ResolvedTrack {
  constructor(title, description, lessons) {
    this.title = title;
    this.description = description;
    this.lessons = lessons;
  }
}

class Lesson {
  constructor(title, description, media) {
    this.title = title;
    this.description = description;
    this.media = media;
  }
}

const hostnameEnv = 'POD101_HOSTNAME';
const usernameEnv = 'POD101_USERNAME';
const passwordEnv = 'POD101_PASSWORD';

const RATE_LIMIT_REQUEST_PER_SECOND = 10;
const MAX_CONCURRENT_DOWNLOADS = 5;

const DOWNLOAD_SUCCESS = 0;
const DOWNLOAD_SKIPPED = 1;
const DOWNLOAD_FAILED = 2;

const globalRequestLimiter = new limiter.RateLimiter(RATE_LIMIT_REQUEST_PER_SECOND, 'second');

const limit = promisify((t, cb) => {
  globalRequestLimiter.removeTokens(t, cb);
});

const unsafePathChar = /[<>:"/\\|?*]/gi;

function safePathName(str) {
  return str.replace(unsafePathChar, '');
}

function consoleWrap(fn) {
  return (...args) => {
    callbackify(fn)(...args, ((err, code) => {
      if (err) {
        console.error(err.stack);
        process.exit(1);
      } else {
        process.exit(code);
      }
    }));
  };
}

function credentials(argv) {
  const username = argv.username || process.env[usernameEnv];

  if (username == null) {
    console.error('ERROR: No username');
    process.exit(1);
  }

  const password = process.env[passwordEnv];

  if (password == null) {
    console.error('ERROR: No password');
    process.exit(1);
  }

  const hostname = argv.hostname || process.env[hostnameEnv];

  if (password == null) {
    console.error('ERROR: No hostname');
    process.exit(1);
  }

  return { username, password, hostname };
}

function getFileName(i, title, subtitle, href) {
  const filename = path.basename(new URL(href).pathname);
  return `${numeral(i + 1).format('00')}__${filename}`;
}

async function resolveLesson(hostname, lessonHref) {
  const url = `https://${hostname}${lessonHref}`;
  await limit(1);
  return get({ url });
}

async function resolveTrack(hostname, trackHref) {
  const url = `https://${hostname}${trackHref}`;
  await limit(1);
  return get({ url });
}

function resolveHref(hostname, href) {
  const parsed = url.parse(href);
  if (parsed.protocol != null) {
    return href;
  }
  return `https://${hostname}${href}`;
}

function crawlLibrary(libraryHtml) {
  const $ = cheerio.load(libraryHtml);
  return $('#collections .list .ll-collection-all')
    .map((i, n) => $(n).attr('href')).get();
}

function crawlTrack(trackHtml, trackHref) {
  const $ = cheerio.load(trackHtml);
  const title = $('.cl-collection h1').text();

  console.error(`INFO : Scraping track: ${title} [${trackHref}]`);

  const description = $('.cl-collection .cl-collection__description').text();
  const lessonHrefs = $('.cl .cl-lesson__lesson').map((i, n) => $(n).attr('href')).get();
  return new Track(title, description, lessonHrefs);
}

function crawlLesson(hostname, lessonHtml, lessonHref) {
  const $ = cheerio.load(lessonHtml);
  const title = $('div:has(p) > h1').text();
  const description = $('div h1 ~ p').text();

  console.error(`INFO : Scraping lesson: ${title} [${lessonHref}]`);

  const pdfs = $('#pdfs li a').map((i, n) => new Media($(n).text(), resolveHref(hostname, $(n).attr('href')))).get();
  const media = $('#download-center li a').map((i, n) => new Media($(n).text(), resolveHref(hostname, $(n).attr('href')))).get();

  const lesson = new Lesson(title, description, [...pdfs, ...media]);

  return lesson;
}

function prepareDownloads(resolvedTracks, destination) {
  return resolvedTracks.flatMap((t) => {
    const trackDest = path.join(destination, safePathName(t.title));
    return t.lessons.flatMap((l, i) => l.media.map((m) => new Download(
      path.join(trackDest, getFileName(i, l.title, m.name, m.href)), m.href,
    )));
  });
}

async function executeDownload(downloadDef, i) {
  const url = downloadDef.srcHref;
  const file = downloadDef.dest;
  const dir = path.dirname(file);
  await mkdirp(dir);
  const exists = await access(file, fs.constants.F_OK).then(() => true, () => false);

  if (exists) {
    console.error(`INFO : [${i}] Skipped downloading existing file ${file}`);
    return DOWNLOAD_SKIPPED;
  }

  await limit(1);

  const temp = `${file}.part`;
  const outStream = fs.createWriteStream(temp);
  try {
    await new Promise((resolve, reject) => {
      client
        .get({ url })
        .on('response', (res) => {
          if (res.headers['content-type'] === 'text/html') {
            reject(new Error('Something\'s fishy. Retry later.'));
          }
        })
        .on('error', reject)
        .on('end', resolve)
        .pipe(outStream);
    });
  } catch (e) {
    console.error(`ERROR: [${i}] Failed downloading file ${file}: ${e.message}`);
    return DOWNLOAD_FAILED;
  }

  await rename(temp, file);
  console.error(`INFO : [${i}] ${file} downloaded [${url}]`);
  return DOWNLOAD_SUCCESS;
}

async function login({ username, password, hostname }, redirectHref) {
  const url = `https://${hostname}/member/login_new.php`;
  const form = {
    amember_login: username,
    amember_pass: password,
    amember_redirect_url: redirectHref,
  };
  const res = await post({
    url, form, followAllRedirects: true, jar: true,
  });
  if (res.body.includes('The username and password you entered did not match our records.')) {
    throw new Error('Invalid credentials');
  }
  return res;
}

async function crawl(library, credentials) {
  const res = await login(credentials, `https://${credentials.hostname}/lesson-library/${library}`);

  const trackUrls = crawlLibrary(res.body);

  const tracks = await Promise
    .all(trackUrls.map(
      (u) => resolveTrack(credentials.hostname, u).then((res) => crawlTrack(res.body, u)),
    ));

  const resolvedTracks = await Promise.all(tracks.map((track) => Promise
    .all(track.lessonHrefs.map(
      (u) => resolveLesson(credentials.hostname, u)
        .then((res) => crawlLesson(credentials.hostname, res.body, u)),
    ))
    .then((lessons) => new ResolvedTrack(track.title, track.description, lessons))));

  console.log(JSON.stringify(resolvedTracks));
  return 0;
}

async function download(defJson, dest, credentials) {
  await login(credentials, `https://${credentials.hostname}/dashboard`);

  const definition = JSON.parse(await readFile(defJson));

  const downloads = prepareDownloads(definition, dest);

  console.error(`INFO : Starting to download ${downloads.length} items`);

  const results = await parallelLimit(
    downloads.map((element, i) => async () => executeDownload(element, i)),
    MAX_CONCURRENT_DOWNLOADS,
  );

  const stats = new Map([
    [DOWNLOAD_FAILED, 0],
    [DOWNLOAD_SUCCESS, 0],
    [DOWNLOAD_SKIPPED, 0],
  ]);

  results.forEach((res) => { stats.set(res, stats.get(res) + 1); });

  const failed = stats.get(DOWNLOAD_FAILED);
  const success = stats.get(DOWNLOAD_SUCCESS);
  const skipped = stats.get(DOWNLOAD_SKIPPED);
  const all = results.length;

  console.error(
    `INFO : Processed ${all} items. [SUCCESS:${success}|SKIPPED:${skipped}|FAILED:${failed}]`,
  );

  if (stats[DOWNLOAD_FAILED] > 0) {
    console.error(
      'ERROR: There was an error downloading some items. Retry.',
    );
    return 2;
  }
  return 0;
}

const { argv } = yargs
  .scriptName('pod101-scraper')
  .option('u', {
    alias: 'username',
    type: 'string',
    describe: 'Login username',
  })
  .option('h', {
    alias: 'hostname',
    type: 'string',
    describe: 'Hostname of the site',
  })
  .command('crawl [library]', 'Crawl a library or level for lessons', (yargs) => {
    yargs.positional('library', {
      type: 'string',
      describe: 'the library to start from',
    });
  })
  .command('download [def_json] [destination]', 'Download lessons', (yargs) => {
    yargs.positional('def_json', {
      type: 'string',
      describe: 'the library to start from',
    }).positional('destination', {
      type: 'string',
      describe: 'output directory',
    });
  })
  .help();

if (argv._.includes('crawl')) {
  consoleWrap(crawl)(argv.library, credentials(argv));
} else {
  consoleWrap(download)(argv.def_json, argv.destination, credentials(argv));
}
