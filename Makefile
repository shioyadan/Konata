run:
	electron --debug=5858 . 

build: clean
	electron-packager . konata \
		--out=packaging-work \
		--platform=darwin,win32,linux \
		--arch=x64  \
		--electron-version=1.4.13 \
		--ignore work \
		--ignore packaging-work \

pack: build
	cd packaging-work/konata-linux-x64; tar -cvzf ../konata-linux-x64.tar.gz *
	cd packaging-work/konata-win32-x64; zip -r ../konata-win32-x64.zip *
	cd packaging-work/konata-darwin-x64; tar -cvzf ../konata-darwin-x64.tar.gz *

clean:
	rm packaging-work -r -f
