run:
	electron --debug=5858 . 
pack:
	electron-packager . konata --out=packaging-work --platform=darwin,win32,linux --arch=x64 --version=1.4.13

clean:
	rm packaging-work -r -f
