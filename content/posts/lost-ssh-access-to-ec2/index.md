+++
title = "🔧 Lost SSH Access to Ec2 ?"
description = "Losing SSH access to an Amazon EC2 instance can be a frustrating experience, especially when common solutions like EC2 Instance Connect or Session Manager are unavailable. In this blog post, we'll explore a lesser-known but effective method to regain access by leveraging EC2 user data."
date = 2024-08-09T16:42:51+05:30
lastmod = 2024-08-09T16:42:51+05:30
publishDate = "2024-08-09T16:42:51+05:30"
draft = false
tags = ['aws', 'ec2', 'ssh']
images = ["og-93f1d193.png"]
hnItemId = 41270300
theme = "steel"
+++

{{< viz kind="lssh-hero" frame="none" fallback="hero.svg" alt="A new SSH key in EC2 user data meets two cloud-init marker files. The init-stage marker for users_groups exists, so the key is blocked. The final-stage marker config_users_groups.once does not exist, so users-groups runs and appends the key to authorized_keys." caption="The paths are real cloud-init paths; `<id>` is the instance ID." >}}


Losing SSH access to an Amazon EC2 instance can be a frustrating experience, especially when common solutions like EC2 Instance Connect or Session Manager are unavailable. In this blog post, we'll explore a lesser-known but effective method to regain access by leveraging EC2 user data.

# Why This Method Works

EC2 user data is text you attach to an instance. EC2 serves it to the instance
through the instance metadata service (IMDS), and cloud-init, the program that
sets up the instance at boot, runs it as root. By default, user data scripts
and cloud-init directives run only on the first boot of an instance[^ud].

Cloud-init still fetches the user data on every boot. What stops it from acting
again is a set of marker files on the root volume. The module that writes SSH
keys, `users_groups`, runs once per instance ID and then writes
`/var/lib/cloud/instances/<instance-id>/sem/config_users_groups`. A stop and
start keeps the instance ID, so a new `users:` block on its own does nothing:
the module finds its marker and skips.

The script below works around the marker. Its `cloud_final_modules` list
replaces the modules the final stage runs, and runs `users-groups` again with
frequency `once`. That frequency checks a different marker, one that does not
exist yet. In the figure, you are cloud-init on the recovery boot:

{{< viz kind="lssh-play" frame="none" fig="1" title="Play cloud-init" fallback="boot.svg" alt="The recovery boot as a cloud-init log and the files it checks: users_groups is skipped because its per-instance marker exists; users-groups runs with frequency once, creates config_users_groups.once, and appends the new key to authorized_keys" caption="Log lines, paths, and byte counts come from cloud-init 26.1 on Ubuntu 24.04, run in a container with a local (NoCloud) data source in place of IMDS. The instance ID and key bodies are samples." >}}

# Step-by-Step Guide

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

# Technical Details

- `Content-Type: multipart/mixed` wraps the config as one MIME part, so you can
  add more parts, such as a shell script, to the same user data.
- The `#cloud-config` line marks the part as cloud-config YAML.
- `cloud_final_modules` replaces the list of modules the final stage runs. On
  this boot the list is only `users-groups`, with frequency `once`.
- `users` names the user and the keys to add. Cloud-init appends the keys and
  keeps the ones already in `authorized_keys`.
- Older guides spell the key list `ssh-authorized-keys`. It still works, but
  cloud-init has marked it deprecated since version 18.3; use
  `ssh_authorized_keys`.

`once` means once per disk, not once per recovery. The marker
`/var/lib/cloud/sem/config_users_groups.once` stays on the root volume, so a
second recovery with the same line does nothing. `always` keeps no marker, but
while it stays in user data it adds the key back on every boot, even after you
delete it by hand. With either line in place, the final stage skips its other
modules, such as `scripts_user` and `final_message`. That is why step 7 clears
the user data. Which line fits depends on your instance:

{{< viz kind="lssh-choose" frame="none" wide="false" fig="2" title="Which line should you paste?" fallback="lanes.svg" alt="once adds the key on the first recovery and skips a second one; always adds the key every time but re-adds it on every boot while set; no override never adds it" caption="The three boots come from the same container runs as Fig. 1." >}}

If you used `once` and may need this again, delete
`/var/lib/cloud/sem/config_users_groups.once` once you are back in.

# Considerations

- This method works for Amazon Linux, Ubuntu, and most other Linux distributions that use cloud-init.
- It's important to use this method responsibly and ensure you have the right to access the instance.
- A stop and start keeps the EBS root volume and the instance ID, but loses
  data on instance store volumes. Back up the root volume first[^kc].
- AWS also documents other ways back in: Systems Manager, EC2 Instance
  Connect, the EC2 serial console, and a rescue instance[^kc].

# Conclusion

While losing SSH access to an EC2 instance can be problematic, the user data method provides a powerful way to regain control. By understanding and utilizing EC2's user data feature, you can quickly restore access and get back to managing your instances effectively.

[^ud]: <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/user-data.html>
[^kc]: <https://repost.aws/knowledge-center/user-data-replace-key-pair-ec2>
