<?php
require __DIR__.'/../app/bootstrap.php';require __DIR__.'/../app/zip-source.php';
foreach(['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.0.1','100.64.0.1','198.18.0.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','2002:7f00:1::1','2001:db8::1'] as $ip){if(public_ip($ip))throw new RuntimeException('Unsafe IP allowed: '.$ip);}
if(!public_ip('8.8.8.8'))throw new RuntimeException('Public address rejected');
foreach(['file:///etc/passwd','http://127.0.0.1/x.zip','http://10.0.0.1/x.zip','http://[::1]/x.zip','https://user:password@example.com/x.zip','http://example.com:8080/x.zip','http://localhost/x.zip'] as $url){try{zip_url_target($url);throw new RuntimeException('Unsafe URL allowed');}catch(InvalidArgumentException){}}
if(redirect_zip_url('https://example.com/path/file.zip','../new.zip')!=='https://example.com/path/../new.zip')throw new RuntimeException('Relative redirect failed');
echo "Private/reserved IPs, unsafe schemes/ports/credentials and redirect resolution passed.\n";
