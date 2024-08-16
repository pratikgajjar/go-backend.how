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

Losing SSH access to an Amazon EC2 instance can be a frustrating experience, especially when common solutions like EC2 Instance Connect or Session Manager are unavailable. In this blog post, we'll explore a lesser-known but effective method to regain access by leveraging EC2 user data.

# Why This Method Works

EC2 user data is a feature that allows you to pass scripts or cloud-config directives to an instance at launch time. These scripts run with root privileges when the instance boots. By modifying the user data to include your SSH key, you can ensure that your key is added to the authorized_keys file of a specific user, granting you SSH access.

# How It Works

EC2 instances read and execute user data on every boot.
Cloud-init, a widely used system for handling cloud instance initialization, processes the user data.
The cloud-config directive in the user data instructs cloud-init to add your SSH key to the specified user's authorized_keys file.

# Step-by-Step Guide

1. Stop the EC2 instance (do not terminate it).
2. Edit the instance's user data:

- Go to the EC2 console
- Select the instance
- Click "Actions" > "Instance Settings" > "Edit user data"

3. Insert the following cloud-config script:

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

4. Replace {your_public_key} with your actual public key and {your_identifier} with a meaningful identifier (usually your email or username).
5. Save the changes and start the instance.
6. Once the instance is running, try to SSH into it using the key you specified.

# Technical Details

- The `Content-Type: multipart/mixed` header allows for multiple directives in the user data.
- The #cloud-config: line tells cloud-init that this is a cloud-config file.
- The cloud_final_modules section ensures that the users-groups module runs only once.
- The users section specifies which user(s) to modify and what SSH keys to add.

# Considerations

- This method works for Amazon Linux, Ubuntu, and most other Linux distributions that use cloud-init.
- It's important to use this method responsibly and ensure you have the right to access the instance.
- Remember to remove or update the user data after regaining access to maintain security.

# Conclusion

While losing SSH access to an EC2 instance can be problematic, the user data method provides a powerful way to regain control. By understanding and utilizing EC2's user data feature, you can quickly restore access and get back to managing your instances effectively.
