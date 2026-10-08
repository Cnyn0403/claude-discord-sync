import pkg from '../package.json'

// The release workflow sets this to the git tag (e.g. v0.2.0-beta.2) with `bun build --define`.
declare const CDS_BUILD_VERSION: string

/** The release tag this executable was built from; source checkouts report `v<package version>-dev`. */
export const VERSION: string = typeof CDS_BUILD_VERSION === 'string' ? CDS_BUILD_VERSION : `v${pkg.version}-dev`
