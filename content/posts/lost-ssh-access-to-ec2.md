+++
title = "Lost SSH Access to Ec2 ?"
description = ""
date = 2024-08-09T16:42:51+05:30
lastmod = 2024-08-09T16:42:51+05:30
publishDate = "2024-08-09T16:42:51+05:30"
draft = false
tags = []
images = []
+++

I've lost SSH access to an EC2 instance more than once, with no options like EC2 Instance Connect, Session Manager, or other methods available. In such cases, you can regain access by editing the EC2 user data script to include your SSH key, then starting the instance. Voila! You'll have access to the instance again.

```bash
Content-Type: multipart/mixed; boundary="//"
MIME-Version: 1.0

--//
Content-Type: text/cloud-config; charset="us-ascii"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="cloud-config.txt"

#cloud-config
cloud_final_modules:
- [users-groups, once]
users:
  - name: ubuntu
    ssh-authorized-keys:
    - ssh-ed25519 {key} {identifier}
```
