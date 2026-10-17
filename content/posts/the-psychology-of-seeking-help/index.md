+++
title = "🧩 The Psychology of Seeking Help"
description = "Five ways engineers ask for help, three ways they take the fix, and where to ask. How to recognise the pattern from the first message and give the help that fits."
date = 2024-07-05T22:21:15+05:30
lastmod = 2024-07-05T22:21:15+05:30
publishDate = "2024-07-05T22:21:15+05:30"
draft = false
tags = ['gyan', 'engineering']
images = ["og-f507b89c.png"]
theme = "wisteria"
+++

The first message someone sends when they are stuck tells you most of what they need from you. This post sorts help seekers into five types by how much they tried before asking, and into three types by how they take the fix. By the end, you should be able to identify the type of a message in a few seconds, give the help that type needs, and know where to ask so that one answer helps more than one person.

As a backend engineer, I've seen the same few patterns in how people ask for help. A pattern describes how someone asks in one moment. The same engineer can be a Direct Seeker on a busy Monday and a Persistent Problem Solver on Friday.

# Types of Help Seekers

The types differ in two things: the effort spent before asking, and the difficulty of the problem.

## The Persistent Problem Solver

**Effort Level:** High  
**Difficulty:** High

They try several approaches before they ask, and they have often narrowed the issue down. They want confirmation or a new view. Their message explains what they tried and ends with a specific question.

## The Exhausted Effort

**Effort Level:** High  
**Difficulty:** High

They have tried everything they can think of and failed. They ask as a last resort, hoping for the one hint that fixes it. Their message lists every attempt, often with visible frustration.

## The Unrelated Connector

**Effort Level:** High  
**Difficulty:** Medium

They have solved related problems before but do not see how those connect to this one. They need someone to explain how the earlier problems relate to this one.

## The Direct Seeker

**Effort Level:** Low  
**Difficulty:** Unknown

They ask as soon as they hit the problem, without trying first. They assume someone else has a ready answer, and they may not know how hard the problem is.

## The Delegator

**Effort Level:** Low  
**Difficulty:** Low

They know the problem but prefer not to solve it. Someone else can do it faster, or they see it as outside their job. They take little part in the fix.

## Reading the first message

The type usually shows in the first message. Fig. 1 has five sample messages about the same failing test.

{{< viz kind="sorter" fig="1" title="Who wrote this?" wide="false" fallback="sorter.svg" alt="Five sample Slack messages about the same failing test, one per help seeker type, with the phrases that identify each type" caption="Pick a type before the clues appear. The messages are samples." >}}

# Reactions to Solutions

After the fix arrives, what the person does next decides whether they will need the same help again.

## The Inquisitive Learner

They want to understand the fix so the issue does not come back. They ask how it works and ask clarifying questions.

## The Solution Seeker

They care only about the immediate issue. They want the fix and do not ask how it works, and they struggle to answer detailed questions about it.

## The Disinterested

They have no interest in the problem or the fix. They want it resolved fast, with as little involvement as possible.

# Where to ask

A phone or WhatsApp call needs the other person right now. They stop what they are doing, and the answer is not written down anywhere. A direct message or personal email does not interrupt anyone. Only one person sees it. If they are busy, you wait, and the answer stays private.

A message in a public channel avoids both problems. It does not force anyone to stop work. Anyone who is free can answer, and the answer stays searchable for the next person who hits the same problem.

# Takeaways

How someone asks tells you what they need. A persistent solver wants a second opinion. A direct seeker first needs someone to find out how hard the problem is. When you recognise the pattern, you can give that help. When you ask in public, more than one person can use the answer.

To find the type of your own last ask, answer the three questions in Fig. 2.

{{< viz kind="last-ask" fig="2" title="Your last ask" wide="false" fallback="last-ask.svg" alt="Three questions about the last time you asked for help, and the seeker type, reaction, and channel each answer points to" caption="Answers map to the types above. Nothing you pick leaves this page." >}}
