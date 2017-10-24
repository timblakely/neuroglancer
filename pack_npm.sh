#! /bin/bash

rm -rf npm

# npm run build-min

tsc -p . --sourceMap --outDir npm -m es2015

mv npm/neuroglancer _tmp
rm -rf npm
mv _tmp npm

cp -r src/neuroglancer/* npm/
find npm/ -name "*.ts" -and -not -name "*.d.ts" -exec rm {} \;

# Copy built elements from dist/min
cp dist/min/chunk_worker.bundle.js npm
cp dist/min/styles.css npm

# Copy package.
cp package.json npm
cp LICENSE npm



(cd npm && npm pack)
