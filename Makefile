run:
	electron --debug=5858 . 

init:
	npm install
	chmod 755 ./node_modules/license-checker/bin/license-checker

build: clean
	./node_modules/license-checker/bin/license-checker --production --relativeLicensePath > THIRD-PARTY-LICENSES.md
	electron-packager . konata \
		--out=packaging-work \
		--platform=darwin,win32,linux \
		--arch=x64  \
		--electron-version=1.7.5 \
		--ignore work \
		--ignore packaging-work \
		--prune=true	# Exclude devDependencies

DOCUMENTS = README.md LICENSE.md THIRD-PARTY-LICENSES.md
pack: build
	cp $(DOCUMENTS) -t ./packaging-work/
	cd packaging-work/; zip -r konata-win32-x64.zip konata-win32-x64 $(DOCUMENTS)
	cd packaging-work/; tar -cvzf konata-linux-x64.tar.gz konata-linux-x64 $(DOCUMENTS)
	cd packaging-work/; tar -cvzf konata-darwin-x64.tar.gz konata-darwin-x64 $(DOCUMENTS)

clean:
	rm packaging-work -r -f

distclean: clean
	rm node_modules -r -f
