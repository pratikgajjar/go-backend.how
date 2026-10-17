+++
title = "🔧 Lost SSH Access to Ec2 ?"
description = "Lost the private key for an EC2 instance? Add a new public key through user data, and see why a plain users: block does nothing while one cloud_final_modules line makes it work."
date = 2024-08-09T16:42:51+05:30
lastmod = 2024-08-09T16:42:51+05:30
publishDate = "2024-08-09T16:42:51+05:30"
draft = false
tags = ['aws', 'ec2', 'ssh']
images = ["og-93f1d193.png"]
hnItemId = 41270300
theme = "steel"
+++

If you lose the private key for an EC2 instance, you can give it a new public
key through its user data: stop the instance, paste a short cloud-config, and
start it again. This post gives that script, shows why the obvious version
(just putting your key in user data) does nothing, and explains the one line
that makes it work, down to the files cloud-init checks on disk.

# When the usual ways are not available

AWS documents several ways back into an instance[^kc]. Each one needs something
that was set up before you lost the key[^pre]:

- **EC2 Instance Connect** needs the Instance Connect package on the instance
  and a network path to SSH.
- **Session Manager** needs SSM Agent running on the instance, registered as a
  managed node.
- **EC2 Serial Console** needs a Nitro-based instance and an OS user with a
  password that you set up earlier.
- **A rescue instance** needs nothing on the locked instance, but you detach its
  root volume, attach it to another instance, edit `authorized_keys`, and move
  the volume back.

# Why user data

User data is text you attach to an instance. EC2 serves it to the instance
through the instance metadata service (IMDS), and cloud-init, the program that
set up the instance at launch, reads it at boot and runs it as root. Amazon
Linux, Ubuntu, and most other Linux distributions for the cloud ship
cloud-init, so there is nothing to install. It takes one stop and start, and
you never touch the volume.

# The obvious attempt does not work

The natural first try is to put your new key in the user data under `users:`
and restart. Guess what happens before you read on:

{{< viz kind="lssh-restart" fig="1" title="A key in user data, then a restart" fallback="restart.svg" alt="A new SSH key in EC2 user data meets two cloud-init marker files. The init-stage marker for users_groups exists since launch, so the module skips. With the cloud_final_modules line, the final stage runs users-groups under the marker config_users_groups.once, which does not exist yet, so it runs and appends the key to authorized_keys." caption="The paths are real cloud-init paths; `<id>` is the instance ID." >}}

By default, user data scripts and cloud-init directives run only on the first
boot of an instance[^ud]. Cloud-init still fetches the user data on every boot.
What stops it from acting again is a set of marker files on the root volume.
The module that writes SSH keys, `users_groups`, runs once per instance ID and
then writes `/var/lib/cloud/instances/<instance-id>/sem/config_users_groups`.
A stop and start keeps the instance ID, so the module finds its marker and
skips.

# How the fix works

The script below adds a `cloud_final_modules` list. It replaces the modules the
final stage of cloud-init runs, and runs `users-groups` again with frequency
`once`. That frequency checks a different marker,
`/var/lib/cloud/sem/config_users_groups.once`, which does not exist yet. So the
module runs, writes that marker, and appends your key to `authorized_keys`.

# Step by step

1. Stop the EC2 instance (do not terminate it). EC2 lets you edit user data
   only while the instance is stopped.
2. Edit the instance's user data:
   - Go to the EC2 console
   - Select the instance
   - Click "Actions" > "Instance Settings" > "Edit user data"
3. Insert the following cloud-config script:

```txt
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
    ssh_authorized_keys:
    - ssh-ed25519 {key} {identifier}
```

4. Replace `ssh-ed25519 {key} {identifier}` with the full line from your new
   `.pub` file. The last field is a comment, usually your email or username.
   Replace `ubuntu` with the instance's login user, for example `ec2-user` on
   Amazon Linux.
5. Save the changes and start the instance.
6. Once the instance is running, SSH into it with the new key. The public IP
   changes on a stop and start unless the instance has an Elastic IP.
7. Stop the instance, clear the user data, and start it again.

What each part of the script does:

- `Content-Type: multipart/mixed` wraps the config as one MIME part, so you can
  add more parts, such as a shell script, to the same user data.
- The `#cloud-config` line marks the part as cloud-config YAML.
- `cloud_final_modules` replaces the list of modules the final stage runs. On
  this boot the list is only `users-groups`, with frequency `once`.
- `users` names the user and the keys to add. Cloud-init appends the keys and
  keeps the ones already in `authorized_keys`.
- Older guides spell the key list `ssh-authorized-keys`. It still works, but
  cloud-init has marked it deprecated since version 18.3.

# once or always

The script uses `once`. Suppose you need it a second time on the same instance:

{{< viz kind="lssh-again" fig="2" title="A second recovery" fallback="again.svg" alt="A second recovery with the same [users-groups, once] line: the marker config_users_groups.once from the first recovery exists, so users-groups skips and the third key is not added. With [users-groups, always] there is no marker, so the module runs and adds the key." caption="The log line is from cloud-init 26.1 on Ubuntu 24.04, run in a container." >}}

`once` means once per disk, not once per recovery. The marker
`/var/lib/cloud/sem/config_users_groups.once` stays on the root volume, so a
second recovery with the same line does nothing. An image made from the volume
carries the marker too, unless `cloud-init clean` ran first.

`always` keeps no marker, but while it stays in user data it adds the key back
on every boot, even after you delete it by hand. With either line in place, the
final stage skips its other modules, such as `scripts_user` and
`final_message`. That is why step 7 clears the user data.

Use `once` on a disk that has never been recovered this way. If it has, or you
are not sure, use `always` and clear the user data as soon as you are in. To
keep `once` working for next time, delete
`/var/lib/cloud/sem/config_users_groups.once` once you are back in.

# Limits

- This method needs cloud-init. Amazon Linux, Ubuntu, and most other Linux
  distributions for the cloud have it. If cloud-init is missing or broken, use a
  rescue instance[^kc].
- A stop and start keeps the EBS root volume and the instance ID, but loses
  data on instance store volumes. Back up the root volume first[^kc].
- Use this method only on instances you have the right to access. Anyone who can
  edit an instance's user data can add a key this way.

# Takeaways

1. Stop, edit user data, start: the instance gets a new key without you
   touching its volume.
2. A `users:` block alone does nothing on an existing instance. `users_groups`
   ran at launch, and its marker file says so.
3. The `cloud_final_modules` entry `[users-groups, once]` runs the same module
   again under a marker that does not exist yet.
4. `once` works once per disk. For a second recovery, use `always` or delete
   the marker.
5. Clear the user data when you are back in.

[^ud]: <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html>
[^kc]: <https://repost.aws/knowledge-center/user-data-replace-key-pair-ec2>
[^pre]: <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-connect-prerequisites.html>, <https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-prerequisites.html>, <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-serial-console-prerequisites.html>
